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
      "id, user_id, status, platform, artifact_path, keystore_id, repo, github_run_id, codemagic_build_id, project_kind, app_name, bundle_id, web_dir, logo_path",
    )
    .eq("id", buildId)
    .single();
  if (error || !data) throw new Error("Build not found");
  if (data.user_id !== userId) throw new Error("Forbidden");
  return data;
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
  .inputValidator((d: { buildId: string }) => z.object({ buildId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const build = await loadBuild(supabase, userId, data.buildId);

    if (build.platform === "ios") {
      return dispatchIos(supabase, userId, build);
    }
    return dispatchAndroid(supabase, userId, build);
  });

async function dispatchAndroid(
  supabase: any,
  userId: string,
  build: any,
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

  await dispatchWorkflow(g, ANDROID_REPO_NAME, ANDROID_WORKFLOW_FILENAME, {
    build_id: build.id,
    source_url: signed.signedUrl,
    project_kind: build.project_kind ?? "capacitor-full",
    app_name: build.app_name ?? "App",
    bundle_id: build.bundle_id ?? "com.apkforge.app",
    web_dir: build.web_dir ?? "www",
    logo_url: logoUrl,
  });

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

async function dispatchIos(supabase: any, userId: string, build: any) {
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
      APP_STORE_CONNECT_ISSUER_ID: signing.issuerId,
      APP_STORE_CONNECT_KEY_IDENTIFIER: signing.keyId,
      APP_STORE_CONNECT_PRIVATE_KEY: signing.privateKey,
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
    const zipBuf = await getArtifactDownload(g, repoName, runId);
    if (!zipBuf) throw new Error("No artifact produced by workflow.");
    const artifactPath = `${userId}/${build.id}.zip`;
    const { error: upErr } = await supabaseAdmin.storage
      .from("build-artifacts")
      .upload(artifactPath, new Blob([zipBuf], { type: "application/zip" }), {
        upsert: true,
        contentType: "application/zip",
      });
    if (upErr) throw upErr;
    await supabaseAdmin
      .from("builds")
      .update({ status: "success", artifact_path: artifactPath })
      .eq("id", build.id);
    return { status: "success", html_url: run.html_url };
  }

  const tail = await getFailureTail(g, repoName, runId);
  await supabaseAdmin.from("build_logs").insert({ build_id: build.id, chunk: tail });
  await supabaseAdmin
    .from("builds")
    .update({ status: "failed", error_summary: `Workflow ${run.conclusion}. See logs.` })
    .eq("id", build.id);
  return { status: "failed", html_url: run.html_url };
}

async function refreshIos(supabase: any, userId: string, build: any) {
  const { requireCodemagicEnv, getBuild, mapCodemagicStatus, tailFromActions, downloadArtifact } =
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
    const ipa = (cmBuild.artefacts ?? []).find((a) => a.name.toLowerCase().endsWith(".ipa"));
    if (!ipa) throw new Error("Codemagic finished but no .ipa artifact was found.");
    const buf = await downloadArtifact(cm, ipa.url);
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
      .update({ status: "success", artifact_path: artifactPath })
      .eq("id", build.id);
    return { status: "success", html_url: cmBuild.buildUrl };
  }

  const tail = tailFromActions(cmBuild);
  await supabaseAdmin.from("build_logs").insert({ build_id: build.id, chunk: tail });
  await supabaseAdmin
    .from("builds")
    .update({ status: "failed", error_summary: `Codemagic build ${cmBuild.status}.` })
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

    // Storage cleanup (best effort)
    const paths: string[] = [];
    if (build.artifact_path) paths.push(build.artifact_path);
    if (paths.length) {
      await supabase.storage.from("build-artifacts").remove(paths).catch(() => {});
    }
    await supabase.storage.from("build-sources").remove([`${userId}/${build.id}.zip`]).catch(() => {});

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
