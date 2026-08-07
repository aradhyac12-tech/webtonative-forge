import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const ANDROID_REPO_NAME = "apkforge-builds";

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

async function loadBuild(supabase: any, userId: string, buildId: string) {
  const { data, error } = await supabase
    .from("builds")
    .select(
      "id, user_id, status, platform, artifact_path, keystore_id, repo, github_run_id, codemagic_build_id, project_kind, app_name, bundle_id, web_dir, logo_path, node_version, diagnostic_token",
    )
    .eq("id", buildId)
    .single();
  if (error || !data) throw new Error("Build not found");
  if (data.user_id !== userId) throw new Error("Forbidden");
  return data;
}

function cleanAppOrigin(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

async function signLogoUrl(supabase: any, logoPath: string | null): Promise<string> {
  if (!logoPath) return "";
  const { data } = await supabase.storage
    .from("build-sources")
    .createSignedUrl(logoPath, 60 * 60 * 2);
  return data?.signedUrl ?? "";
}

// -----------------------------------------------------------------------------
// Dispatch (Android via GitHub Actions, iOS via Codemagic)
// -----------------------------------------------------------------------------

export const dispatchBuild = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { buildId: string; appOrigin?: string }) =>
    z.object({ buildId: z.string().uuid(), appOrigin: z.string().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const build = await loadBuild(supabase, userId, data.buildId);
    const appOrigin = cleanAppOrigin(data.appOrigin);

    if (build.platform === "ios") {
      return dispatchIos(supabase, userId, build, appOrigin);
    }
    return dispatchAndroid(supabase, userId, build, appOrigin);
  });

// Re-dispatches an existing build with the exact same inputs after clearing the
// previous terminal state, so a failed run can be retried from the build page.
export const retryBuild = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { buildId: string; appOrigin?: string }) =>
    z.object({ buildId: z.string().uuid(), appOrigin: z.string().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const build = await loadBuild(supabase, userId, data.buildId);
    const appOrigin = cleanAppOrigin(data.appOrigin);

    if (!build.artifact_path) {
      throw new Error("The original source zip is no longer available — start a new build.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("builds")
      .update({
        status: "pending",
        error_summary: null,
        github_run_id: null,
        codemagic_build_id: null,
      })
      .eq("id", build.id);
    await supabaseAdmin.from("build_logs").delete().eq("build_id", build.id);

    const fresh = { ...build, status: "pending", github_run_id: null, codemagic_build_id: null };
    if (build.platform === "ios") return dispatchIos(supabase, userId, fresh, appOrigin);
    return dispatchAndroid(supabase, userId, fresh, appOrigin);
  });


async function dispatchAndroid(
  supabase: any,
  userId: string,
  build: any,
  appOrigin: string,
) {
  const {
    ensureRepo,
    upsertFile,
    putSecret,
    dispatchWorkflow,
    findRunForBuild,
  } = await import("./github.server");
  const { ANDROID_WORKFLOW_PATH, ANDROID_WORKFLOW_FILENAME, ANDROID_WORKFLOW_YAML } =
    await import("./android-workflow");

  const { data: gh } = await supabase
    .from("github_connections")
    .select("github_login, access_token")
    .maybeSingle();
  if (!gh) throw new Error("Connect GitHub in Settings first.");

  if (!build.keystore_id) throw new Error("Pick an Android signing keystore first.");
  const { data: ks } = await supabase
    .from("keystores")
    .select("key_alias, keystore_password, key_password, keystore_base64")
    .eq("id", build.keystore_id)
    .single();
  if (!ks) throw new Error("Selected keystore not found.");

  if (!build.artifact_path) throw new Error("Source zip not uploaded.");
  const { data: signed, error: sErr } = await supabase.storage
    .from("build-sources")
    .createSignedUrl(build.artifact_path, 60 * 60);
  if (sErr || !signed) throw new Error("Could not sign source URL.");

  const g = { token: gh.access_token, login: gh.github_login };
  await ensureRepo(g, ANDROID_REPO_NAME);
  await upsertFile(g, ANDROID_REPO_NAME, ANDROID_WORKFLOW_PATH, ANDROID_WORKFLOW_YAML, "APKForge: sync android workflow");
  await putSecret(g, ANDROID_REPO_NAME, "APKFORGE_KEYSTORE_B64", ks.keystore_base64);
  await putSecret(g, ANDROID_REPO_NAME, "APKFORGE_KEYSTORE_PASSWORD", ks.keystore_password);
  await putSecret(g, ANDROID_REPO_NAME, "APKFORGE_KEY_PASSWORD", ks.key_password);
  await putSecret(g, ANDROID_REPO_NAME, "APKFORGE_KEY_ALIAS", ks.key_alias);

  const logoUrl = await signLogoUrl(supabase, build.logo_path);

  await dispatchWorkflow(
    g,
    ANDROID_REPO_NAME,
    ANDROID_WORKFLOW_FILENAME,
    {
      build_id: build.id,
      source_url: signed.signedUrl,
      project_kind: build.project_kind ?? "capacitor-full",
      app_name: build.app_name ?? "App",
      bundle_id: build.bundle_id ?? "com.apkforge.app",
      web_dir: build.web_dir ?? "www",
      logo_url: logoUrl,
      node_version: build.node_version ?? "22",
      finalize_endpoint: appOrigin ? `${appOrigin}/api/public/build-finalize` : "",
      diagnostic_endpoint: appOrigin ? `${appOrigin}/api/public/build-diagnostics` : "",
      diagnostic_token: build.diagnostic_token ?? "",
    },
    ANDROID_WORKFLOW_PATH,
  );


  const runId = await findRunForBuild(g, ANDROID_REPO_NAME, ANDROID_WORKFLOW_FILENAME, build.id);

  await supabase
    .from("builds")
    .update({
      status: "queued",
      repo: `${gh.github_login}/${ANDROID_REPO_NAME}`,
      branch: "main",
      github_run_id: runId,
    })
    .eq("id", build.id);

  return { ok: true, runId };
}

async function dispatchIos(supabase: any, userId: string, build: any, appOrigin: string) {
  const {
    requireCodemagicEnv,
    requireIosSigningEnv,
    startBuild,
  } = await import("./codemagic.server");
  const { ensureRepo, upsertFileOnRepo } = await import("./github.server");
  const { IOS_WORKFLOW_PATH, IOS_WORKFLOW_ID, IOS_WORKFLOW_YAML } =
    await import("./ios-workflow");

  if (!build.bundle_id) throw new Error("Set a bundle ID before starting an iOS build.");
  if (!build.artifact_path) throw new Error("Source zip not uploaded.");

  const cm = requireCodemagicEnv();
  const signing = requireIosSigningEnv();

  const centralToken = process.env.APKFORGE_CENTRAL_GH_TOKEN;
  const centralRepo = process.env.APKFORGE_CENTRAL_GH_REPO; // owner/name
  if (!centralToken || !centralRepo) {
    throw new Error(
      "iOS build repo isn't configured. Workspace admin must set APKFORGE_CENTRAL_GH_TOKEN and APKFORGE_CENTRAL_GH_REPO (owner/name) — this repo must also be connected to the shared Codemagic app.",
    );
  }
  const [ownerLogin, repoName] = centralRepo.split("/");
  if (!ownerLogin || !repoName) throw new Error("APKFORGE_CENTRAL_GH_REPO must be `owner/name`.");

  const { data: signed, error: sErr } = await supabase.storage
    .from("build-sources")
    .createSignedUrl(build.artifact_path, 60 * 60 * 2);
  if (sErr || !signed) throw new Error("Could not sign source URL.");

  const g = { token: centralToken, login: ownerLogin };
  await ensureRepo(g, repoName);
  // Push (or refresh) codemagic.yaml on main
  await upsertFileOnRepo(g, ownerLogin, repoName, IOS_WORKFLOW_PATH, IOS_WORKFLOW_YAML, "APKForge: sync ios workflow");

  const logoUrl = await signLogoUrl(supabase, build.logo_path);

  const cmBuildId = await startBuild(cm, {
    workflowId: IOS_WORKFLOW_ID,
    branch: "main",
    variables: {
      SOURCE_URL: signed.signedUrl,
      BUILD_ID: build.id,
      APP_NAME: build.app_name ?? "App",
      BUNDLE_ID: build.bundle_id,
      WEB_DIR: build.web_dir ?? "www",
      PROJECT_KIND: build.project_kind ?? "capacitor-full",
      LOGO_URL: logoUrl,
      NODE_VERSION: build.node_version ?? "22",
      APP_STORE_CONNECT_ISSUER_ID: signing.issuerId,
      APP_STORE_CONNECT_KEY_IDENTIFIER: signing.keyId,
      APP_STORE_CONNECT_PRIVATE_KEY: signing.privateKey,
      FINALIZE_ENDPOINT: appOrigin ? `${appOrigin}/api/public/build-ios-finalize` : "",
      DIAGNOSTIC_TOKEN: build.diagnostic_token ?? "",
    },
  });

  await supabase
    .from("builds")
    .update({
      status: "queued",
      repo: centralRepo,
      codemagic_build_id: cmBuildId,
    })
    .eq("id", build.id);

  return { ok: true, codemagicBuildId: cmBuildId };
}

// -----------------------------------------------------------------------------
// Refresh status
// -----------------------------------------------------------------------------

export const refreshBuildStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { buildId: string }) => z.object({ buildId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const build = await loadBuild(supabase, userId, data.buildId);
    if (build.platform === "ios") return refreshIos(supabase, userId, build);
    return refreshAndroid(supabase, userId, build);
  });

async function refreshAndroid(supabase: any, userId: string, build: any) {
  const { getRun, getArtifactDownload, getFailureTail, findRunForBuild } =
    await import("./github.server");
  const { ANDROID_WORKFLOW_FILENAME } = await import("./android-workflow");

  if (build.status === "success" || build.status === "failed") return { status: build.status };
  if (!build.repo) return { status: build.status };

  const { data: gh } = await supabase
    .from("github_connections")
    .select("github_login, access_token")
    .maybeSingle();
  if (!gh) return { status: build.status };

  const g = { token: gh.access_token, login: gh.github_login };
  const repoName = build.repo.split("/")[1];

  let runId = build.github_run_id;
  if (!runId) {
    runId = await findRunForBuild(g, repoName, ANDROID_WORKFLOW_FILENAME, build.id);
    if (runId) await supabase.from("builds").update({ github_run_id: runId }).eq("id", build.id);
  }
  if (!runId) return { status: "queued" };

  const run = await getRun(g, repoName, runId);
  if (run.status !== "completed") {
    const newStatus = run.status === "in_progress" ? "in_progress" : "queued";
    if (newStatus !== build.status) {
      await supabase.from("builds").update({ status: newStatus }).eq("id", build.id);
    }
    return { status: newStatus, html_url: run.html_url };
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  if (run.conclusion === "success") {
    try {
      const apkBuf = await getArtifactDownload(g, repoName, runId);
      if (!apkBuf) throw new Error("No APK artifact produced by workflow.");
      const artifactPath = `${userId}/${build.id}.apk`;
      const { error: upErr } = await supabaseAdmin.storage
        .from("build-artifacts")
        .upload(artifactPath, new Blob([apkBuf], { type: "application/vnd.android.package-archive" }), {
          upsert: true,
          contentType: "application/vnd.android.package-archive",
        });
      if (upErr) throw upErr;
      await supabaseAdmin
        .from("builds")
        .update({ status: "success", artifact_path: artifactPath, error_summary: null })
        .eq("id", build.id);
      return { status: "success", html_url: run.html_url };
    } catch (e) {
      return await handleFinalizeFailure(
        supabaseAdmin,
        build.id,
        build.status,
        (e as Error).message,
        run.html_url,
      );
    }
  }

  try {
    const { tail, summary } = await getFailureTail(g, repoName, runId);
    await supabaseAdmin.from("build_logs").insert({ build_id: build.id, chunk: tail });
    await supabaseAdmin
      .from("builds")
      .update({
        status: "failed",
        error_summary: summary ?? `Workflow ${run.conclusion}. See logs.`,
      })
      .eq("id", build.id);
  } catch {
    await supabaseAdmin
      .from("builds")
      .update({ status: "failed", error_summary: `Workflow ${run.conclusion}. Logs unavailable.` })
      .eq("id", build.id);
  }
  return { status: "failed", html_url: run.html_url };
}

/**
 * A build that finished on the CI side but whose artifact/log pickup failed is
 * kept non-terminal (so polling retries) instead of throwing an "Unable to
 * fetch" error at the browser. After MAX_FINALIZE_ATTEMPTS it is marked failed.
 */
const MAX_FINALIZE_ATTEMPTS = 5;

async function handleFinalizeFailure(
  supabaseAdmin: any,
  buildId: string,
  currentStatus: string,
  message: string,
  htmlUrl?: string,
) {
  const marker = "[finalize-retry]";
  const { count } = await supabaseAdmin
    .from("build_logs")
    .select("id", { count: "exact", head: true })
    .eq("build_id", buildId)
    .like("chunk", `${marker}%`);

  const attempts = (count ?? 0) + 1;
  await supabaseAdmin
    .from("build_logs")
    .insert({ build_id: buildId, chunk: `${marker} attempt ${attempts}: ${message}` });

  if (attempts >= MAX_FINALIZE_ATTEMPTS) {
    await supabaseAdmin
      .from("builds")
      .update({
        status: "failed",
        error_summary: `The CI build finished but the artifact could not be collected after ${attempts} attempts: ${message.slice(0, 200)}`,
      })
      .eq("id", buildId);
    return { status: "failed", html_url: htmlUrl };
  }

  return { status: currentStatus === "queued" ? "queued" : "in_progress", html_url: htmlUrl, transient: true };
}

async function refreshIos(supabase: any, userId: string, build: any) {
  const { requireCodemagicEnv, getBuild, mapCodemagicStatus, tailFromActions, resolveIpaBuffer } =
    await import("./codemagic.server");
  if (build.status === "success" || build.status === "failed") return { status: build.status };
  if (!build.codemagic_build_id) return { status: build.status };

  const cm = requireCodemagicEnv();
  const cmBuild = await getBuild(cm, build.codemagic_build_id);
  const mapped = mapCodemagicStatus(cmBuild.status);

  if (!mapped.terminal) {
    if (mapped.status !== build.status) {
      await supabase.from("builds").update({ status: mapped.status }).eq("id", build.id);
    }
    return { status: mapped.status, html_url: cmBuild.buildUrl };
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  if (mapped.conclusion === "success") {
    try {
      const buf = await resolveIpaBuffer(cm, cmBuild);
      if (!buf) throw new Error("Codemagic finished but no .ipa artifact was found.");
      const artifactPath = `${userId}/${build.id}.ipa`;
      const { error: upErr } = await supabaseAdmin.storage
        .from("build-artifacts")
        .upload(artifactPath, new Blob([buf], { type: "application/octet-stream" }), {
          upsert: true,
          contentType: "application/octet-stream",
        });
      if (upErr) throw upErr;
      await supabaseAdmin
        .from("builds")
        .update({ status: "success", artifact_path: artifactPath, error_summary: null })
        .eq("id", build.id);
      return { status: "success", html_url: cmBuild.buildUrl };
    } catch (e) {
      return await handleFinalizeFailure(
        supabaseAdmin,
        build.id,
        build.status,
        (e as Error).message,
        cmBuild.buildUrl,
      );
    }
  }

  const tail = tailFromActions(cmBuild);
  const { summarizeFailure } = await import("./github.server");
  await supabaseAdmin.from("build_logs").insert({ build_id: build.id, chunk: tail });
  await supabaseAdmin
    .from("builds")
    .update({
      status: "failed",
      error_summary: summarizeFailure(tail) ?? `Codemagic build ${cmBuild.status}.`,
    })
    .eq("id", build.id);
  return { status: "failed", html_url: cmBuild.buildUrl };
}


// -----------------------------------------------------------------------------
// Artifact URL
// -----------------------------------------------------------------------------

export const getArtifactUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { buildId: string }) => z.object({ buildId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: build } = await supabase
      .from("builds")
      .select("id, user_id, artifact_path, status")
      .eq("id", data.buildId)
      .single();
    if (!build || build.user_id !== userId) throw new Error("Not found");
    if (build.status !== "success" || !build.artifact_path)
      throw new Error("Artifact not ready.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: signed, error } = await supabaseAdmin.storage
      .from("build-artifacts")
      .createSignedUrl(build.artifact_path, 60 * 15);
    if (error || !signed) throw new Error("Could not sign URL.");
    return { url: signed.signedUrl };
  });

// -----------------------------------------------------------------------------
// Delete / cancel build
// -----------------------------------------------------------------------------

export const deleteBuild = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { buildId: string }) => z.object({ buildId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: build, error } = await supabase
      .from("builds")
      .select("id, user_id, status, platform, repo, github_run_id, codemagic_build_id, artifact_path")
      .eq("id", data.buildId)
      .single();
    if (error || !build) throw new Error("Build not found");
    if (build.user_id !== userId) throw new Error("Forbidden");

    const nonTerminal = !["success", "failed"].includes(build.status);

    if (nonTerminal && build.platform !== "ios" && build.repo && build.github_run_id) {
      try {
        const { data: gh } = await supabase
          .from("github_connections")
          .select("github_login, access_token")
          .maybeSingle();
        if (gh) {
          const repoName = build.repo.split("/")[1];
          await fetch(
            `https://api.github.com/repos/${gh.github_login}/${repoName}/actions/runs/${build.github_run_id}/cancel`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${gh.access_token}`,
                Accept: "application/vnd.github+json",
                "User-Agent": "APKForge",
              },
            },
          );
        }
      } catch {
        // best-effort cancel
      }
    }

    if (nonTerminal && build.platform === "ios" && build.codemagic_build_id) {
      try {
        const { requireCodemagicEnv, cancelBuild } = await import("./codemagic.server");
        const cm = requireCodemagicEnv();
        await cancelBuild(cm, build.codemagic_build_id);
      } catch {
        // best-effort cancel
      }
    }

    // Storage cleanup (best effort) — writes/deletes on build buckets are
    // service-role only; ownership was verified above.
    const { supabaseAdmin: storageAdmin } = await import("@/integrations/supabase/client.server");
    const paths: string[] = [];
    if (build.artifact_path) paths.push(build.artifact_path);
    if (paths.length) {
      await storageAdmin.storage.from("build-artifacts").remove(paths).catch(() => {});
    }
    await storageAdmin.storage.from("build-sources").remove([`${userId}/${build.id}.zip`]).catch(() => {});

    await supabase.from("build_logs").delete().eq("build_id", build.id);
    const { error: delErr } = await supabase.from("builds").delete().eq("id", build.id);
    if (delErr) throw new Error(delErr.message);
    return { ok: true };
  });

// -----------------------------------------------------------------------------
// iOS availability (read-only, exposes booleans only)
// -----------------------------------------------------------------------------

export const iosAvailability = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    return {
      codemagicConfigured:
        !!process.env.CODEMAGIC_API_TOKEN && !!process.env.CODEMAGIC_APP_ID,
      signingConfigured:
        !!process.env.APP_STORE_CONNECT_ISSUER_ID &&
        !!process.env.APP_STORE_CONNECT_KEY_ID &&
        !!process.env.APP_STORE_CONNECT_PRIVATE_KEY,
      repoConfigured:
        !!process.env.APKFORGE_CENTRAL_GH_TOKEN && !!process.env.APKFORGE_CENTRAL_GH_REPO,
    };
  });

// -----------------------------------------------------------------------------
// Build preflight self-check (Settings)
// -----------------------------------------------------------------------------

type PreflightCheck = { name: string; ok: boolean; detail: string };

export const buildPreflight = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const checks: PreflightCheck[] = [];

    const { data: gh } = await supabase
      .from("github_connections")
      .select("github_login, access_token")
      .maybeSingle();

    if (!gh) {
      checks.push({
        name: "GitHub connection",
        ok: false,
        detail: "No GitHub token saved. Connect GitHub above with a token that has the `repo` and `workflow` scopes.",
      });
    } else {
      const headers = {
        Authorization: `Bearer ${gh.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "APKForge",
      };
      const userRes = await fetch("https://api.github.com/user", { headers });
      checks.push({
        name: "GitHub token",
        ok: userRes.ok,
        detail: userRes.ok
          ? `Authenticated as ${gh.github_login}.`
          : `GitHub rejected the saved token (${userRes.status}). Re-connect GitHub with a valid token.`,
      });

      if (userRes.ok) {
        const repoRes = await fetch(
          `https://api.github.com/repos/${gh.github_login}/${ANDROID_REPO_NAME}`,
          { headers },
        );
        if (repoRes.status === 404) {
          checks.push({
            name: "Build repo",
            ok: true,
            detail: `${gh.github_login}/${ANDROID_REPO_NAME} will be created on the first Android build.`,
          });
        } else if (!repoRes.ok) {
          checks.push({
            name: "Build repo",
            ok: false,
            detail: `Could not read ${gh.github_login}/${ANDROID_REPO_NAME} (${repoRes.status}).`,
          });
        } else {
          const repo = (await repoRes.json()) as {
            default_branch?: string;
            permissions?: { push?: boolean; admin?: boolean };
          };
          const canPush = !!repo.permissions?.push;
          checks.push({
            name: "Build repo access",
            ok: canPush,
            detail: canPush
              ? `Push access confirmed on ${gh.github_login}/${ANDROID_REPO_NAME} (default branch ${repo.default_branch ?? "main"}).`
              : "The saved token cannot push to the build repo. Use a token with the `repo` scope.",
          });

          const { ANDROID_WORKFLOW_FILENAME } = await import("./android-workflow");
          const wfRes = await fetch(
            `https://api.github.com/repos/${gh.github_login}/${ANDROID_REPO_NAME}/actions/workflows/${ANDROID_WORKFLOW_FILENAME}`,
            { headers },
          );
          checks.push({
            name: "Android workflow",
            ok: wfRes.ok || wfRes.status === 404,
            detail: wfRes.ok
              ? "Workflow is indexed by GitHub Actions and dispatchable."
              : wfRes.status === 404
                ? "Workflow not pushed yet — it is synced automatically when a build starts."
                : `GitHub returned ${wfRes.status} for the workflow file.`,
          });
        }
      }
    }

    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error: srcErr } = await supabaseAdmin.storage.from("build-sources").list("", { limit: 1 });
      const { error: artErr } = await supabaseAdmin.storage.from("build-artifacts").list("", { limit: 1 });
      const ok = !srcErr && !artErr;
      checks.push({
        name: "Storage buckets",
        ok,
        detail: ok
          ? "build-sources and build-artifacts are reachable."
          : `Bucket problem: ${(srcErr ?? artErr)?.message}`,
      });
    } catch (e) {
      checks.push({ name: "Storage buckets", ok: false, detail: (e as Error).message });
    }

    const cmToken = process.env.CODEMAGIC_API_TOKEN;
    const cmApp = process.env.CODEMAGIC_APP_ID;
    if (!cmToken || !cmApp) {
      checks.push({
        name: "Codemagic (iOS)",
        ok: false,
        detail: "CODEMAGIC_API_TOKEN / CODEMAGIC_APP_ID are not set. Android builds are unaffected.",
      });
    } else {
      try {
        const res = await fetch(`https://api.codemagic.io/apps/${cmApp}`, {
          headers: { "x-auth-token": cmToken, Accept: "application/json" },
        });
        checks.push({
          name: "Codemagic (iOS)",
          ok: res.ok,
          detail: res.ok
            ? "Codemagic app reachable with the configured token."
            : `Codemagic returned ${res.status} for the configured app id.`,
        });
      } catch (e) {
        checks.push({ name: "Codemagic (iOS)", ok: false, detail: (e as Error).message });
      }
    }

    return { checks, allOk: checks.every((c) => c.ok) };
  });

