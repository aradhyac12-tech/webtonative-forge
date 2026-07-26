import { seal } from "tweetnacl-sealedbox-js";

const API = "https://api.github.com";

export type GH = { token: string; login: string };

async function gh<T = unknown>(
  { token }: GH,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T | null; res: Response }> {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "APKForge",
      ...(init.headers ?? {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  let body: T | null = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = text as unknown as T;
    }
  }
  return { status: res.status, body, res };
}

export async function ensureRepo(g: GH, repo: string): Promise<void> {
  const check = await gh(g, `/repos/${g.login}/${repo}`);
  if (check.status === 200) return;
  if (check.status !== 404) {
    throw new Error(
      `GitHub repo check failed (${check.status}): ${JSON.stringify(check.body).slice(0, 200)}`,
    );
  }
  const create = await gh(g, `/user/repos`, {
    method: "POST",
    body: JSON.stringify({
      name: repo,
      private: true,
      auto_init: true,
      description: "APKForge Android build repo (managed)",
    }),
  });
  if (create.status >= 300) {
    throw new Error(
      `GitHub repo create failed (${create.status}): ${JSON.stringify(create.body).slice(0, 200)}`,
    );
  }
}

export async function upsertFileOnRepo(
  g: GH,
  owner: string,
  repo: string,
  path: string,
  contentUtf8: string,
  message: string,
): Promise<void> {
  const existing = await gh<{ sha?: string }>(
    g,
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
  );
  const body: Record<string, unknown> = {
    message,
    content: btoa(unescape(encodeURIComponent(contentUtf8))),
  };
  if (existing.status === 200 && existing.body?.sha) body.sha = existing.body.sha;
  const put = await gh(g, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (put.status >= 300) {
    throw new Error(`GitHub file write failed (${put.status}): ${JSON.stringify(put.body).slice(0, 300)}`);
  }

}

export async function upsertFile(
  g: GH,
  repo: string,
  path: string,
  contentUtf8: string,
  message: string,
): Promise<void> {
  return upsertFileOnRepo(g, g.login, repo, path, contentUtf8, message);
}

export async function putSecret(
  g: GH,
  repo: string,
  name: string,
  value: string,
): Promise<void> {
  const keyRes = await gh<{ key: string; key_id: string }>(
    g,
    `/repos/${g.login}/${repo}/actions/secrets/public-key`,
  );
  if (keyRes.status >= 300 || !keyRes.body) {
    throw new Error(`Fetch public key failed (${keyRes.status})`);
  }
  const publicKey = Uint8Array.from(atob(keyRes.body.key), (c) => c.charCodeAt(0));
  const messageBytes = new TextEncoder().encode(value);
  const encrypted = seal(messageBytes, publicKey);
  let bin = "";
  for (const b of encrypted) bin += String.fromCharCode(b);
  const encryptedValue = btoa(bin);
  const put = await gh(g, `/repos/${g.login}/${repo}/actions/secrets/${name}`, {
    method: "PUT",
    body: JSON.stringify({ encrypted_value: encryptedValue, key_id: keyRes.body.key_id }),
  });
  if (put.status >= 300) throw new Error(`Set secret ${name} failed (${put.status})`);
}

function bodyText(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return body.slice(0, 400);
  try {
    return JSON.stringify(body).slice(0, 400);
  } catch {
    return "";
  }
}

async function getDefaultBranch(g: GH, owner: string, repo: string): Promise<string> {
  const r = await gh<{ default_branch?: string }>(g, `/repos/${owner}/${repo}`);
  return r.body?.default_branch || "main";
}

async function ensureActionsEnabled(g: GH, owner: string, repo: string, workflowFilename: string) {
  try {
    await gh(g, `/repos/${owner}/${repo}/actions/permissions`, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, allowed_actions: "all" }),
    });
  } catch {
    // best effort — token may lack admin scope
  }
  try {
    await gh(g, `/repos/${owner}/${repo}/actions/workflows/${workflowFilename}/enable`, {
      method: "PUT",
    });
  } catch {
    // best effort
  }
}

/** Wait until GitHub has indexed the workflow file so a dispatch can target it. */
async function waitForWorkflow(
  g: GH,
  owner: string,
  repo: string,
  workflowFilename: string,
): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    const r = await gh<{ id?: number; state?: string }>(
      g,
      `/repos/${owner}/${repo}/actions/workflows/${workflowFilename}`,
    );
    if (r.status === 200 && r.body?.id) return true;
    await new Promise((res) => setTimeout(res, 1500));
  }
  return false;
}

/** Inputs declared by the copy of the workflow that currently lives on the repo. */
async function declaredInputs(
  g: GH,
  owner: string,
  repo: string,
  path: string,
): Promise<Set<string> | null> {
  const r = await gh<{ content?: string; encoding?: string }>(
    g,
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
  );
  if (r.status !== 200 || !r.body?.content) return null;
  let yaml: string;
  try {
    yaml = decodeURIComponent(escape(atob(r.body.content.replace(/\n/g, ""))));
  } catch {
    return null;
  }
  const m = yaml.match(/workflow_dispatch:\s*\n\s*inputs:\s*\n([\s\S]*?)(?:\n\S|\njobs:)/);
  const block = m?.[1] ?? yaml.split("inputs:")[1];
  if (!block) return null;
  const names = new Set<string>();
  for (const line of block.split("\n")) {
    const im = line.match(/^\s{6,}([A-Za-z0-9_-]+):/);
    if (im) names.add(im[1]);
  }
  return names.size ? names : null;
}

export async function dispatchWorkflow(
  g: GH,
  repo: string,
  workflowFilename: string,
  inputs: Record<string, string>,
  workflowPath?: string,
): Promise<void> {
  const owner = g.login;
  const ref = await getDefaultBranch(g, owner, repo);
  await ensureActionsEnabled(g, owner, repo, workflowFilename);
  await waitForWorkflow(g, owner, repo, workflowFilename);

  let payloadInputs = inputs;
  let lastError = "";

  for (let attempt = 0; attempt < 5; attempt++) {
    const d = await gh(
      g,
      `/repos/${owner}/${repo}/actions/workflows/${workflowFilename}/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({ ref, inputs: payloadInputs }),
      },
    );
    if (d.status < 300) return;

    lastError = bodyText(d.body);

    // Workflow not indexed yet, or the indexed copy is stale and rejects new inputs.
    if (d.status === 404 || d.status === 422) {
      if (workflowPath && /unexpected inputs/i.test(lastError)) {
        const declared = await declaredInputs(g, owner, repo, workflowPath);
        if (declared) {
          const filtered: Record<string, string> = {};
          for (const [k, v] of Object.entries(inputs)) if (declared.has(k)) filtered[k] = v;
          payloadInputs = filtered;
        }
      }
      await new Promise((res) => setTimeout(res, 2500));
      continue;
    }

    throw new Error(`Workflow dispatch failed (${d.status}): ${lastError}`);
  }

  throw new Error(
    `Workflow dispatch failed (422) on ref "${ref}" after retries: ${lastError || "no details from GitHub"}`,
  );
}


export async function findRunForBuild(
  g: GH,
  repo: string,
  workflowFilename: string,
  buildId: string,
): Promise<number | null> {
  // The workflow's `run-name` embeds the build_id, so we can correlate the run
  // exactly instead of guessing at "the most recent dispatch" (which may be a
  // previous, stale build for the same repo).
  for (let i = 0; i < 8; i++) {
    const r = await gh<{
      workflow_runs: Array<{ id: number; name?: string; display_title?: string; created_at?: string }>;
    }>(
      g,
      `/repos/${g.login}/${repo}/actions/workflows/${workflowFilename}/runs?event=workflow_dispatch&per_page=30`,
    );
    if (r.status === 200 && r.body?.workflow_runs) {
      const match = r.body.workflow_runs.find(
        (run) =>
          (run.display_title && run.display_title.includes(buildId)) ||
          (run.name && run.name.includes(buildId)),
      );
      if (match) return match.id;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  return null;
}

export async function getRun(
  g: GH,
  repo: string,
  runId: number,
): Promise<{ status: string; conclusion: string | null; html_url: string }> {
  const r = await gh<{ status: string; conclusion: string | null; html_url: string }>(
    g,
    `/repos/${g.login}/${repo}/actions/runs/${runId}`,
  );
  if (r.status >= 300 || !r.body) throw new Error(`Get run failed (${r.status})`);
  return r.body;
}

export async function getArtifactDownload(
  g: GH,
  repo: string,
  runId: number,
): Promise<ArrayBuffer | null> {
  const list = await gh<{ artifacts: Array<{ id: number; name: string }> }>(
    g,
    `/repos/${g.login}/${repo}/actions/runs/${runId}/artifacts`,
  );
  if (list.status >= 300 || !list.body?.artifacts?.length) return null;
  const apk = list.body.artifacts.find((a) => a.name.startsWith("apk-")) ?? list.body.artifacts[0];
  const res = await fetch(
    `${API}/repos/${g.login}/${repo}/actions/artifacts/${apk.id}/zip`,
    {
      headers: {
        Authorization: `Bearer ${g.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "APKForge",
      },
      redirect: "follow",
    },
  );
  if (!res.ok) throw new Error(`Artifact download failed (${res.status})`);
  return await res.arrayBuffer();
}

export async function getFailureTail(
  g: GH,
  repo: string,
  runId: number,
): Promise<{ tail: string; summary?: string }> {
  const res = await fetch(
    `${API}/repos/${g.login}/${repo}/actions/runs/${runId}/logs`,
    {
      headers: {
        Authorization: `Bearer ${g.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "APKForge",
      },
      redirect: "follow",
    },
  );
  if (!res.ok) return { tail: `(logs unavailable: ${res.status})` };

  // /logs returns a ZIP archive of per-step .txt files. Parse it and pull the
  // failing step (or the last step) so users get a real error message.
  try {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    const entries = Object.values(zip.files).filter(
      (f) => !f.dir && f.name.toLowerCase().endsWith(".txt"),
    );
    // Prefer the step file that contains FAILED / BUILD FAILED / Error: markers.
    let chosen: { name: string; text: string } | null = null;
    for (const f of entries) {
      const text = await f.async("string");
      if (/FAILED|BUILD FAILED|Error: |error:|Exception|What went wrong/i.test(text)) {
        chosen = { name: f.name, text };
      }
    }
    if (!chosen && entries.length) {
      const last = entries[entries.length - 1];
      chosen = { name: last.name, text: await last.async("string") };
    }
    if (!chosen) return { tail: "(no log files in archive)" };

    const lines = chosen.text.split("\n");
    const tail = `--- ${chosen.name} ---\n` + lines.slice(-200).join("\n");
    return { tail, summary: summarizeFailure(chosen.text) };
  } catch (e) {
    return { tail: `(could not parse logs: ${(e as Error).message})` };
  }
}

function summarizeFailure(text: string): string | undefined {
  const signingFailure = text.match(/SIGNING_VALIDATION_FAILED:\s*([^\n]+)/i);
  if (signingFailure?.[1]) return signingFailure[1].trim().slice(0, 240);
  if (/SIGNING_VALIDATION_PASSED/i.test(text) && /No key with alias .* found in keystore/i.test(text)) {
    return "Android signing validation passed, but Gradle could not find the validated key alias. Re-run the build so the updated workflow uses the validated alias.";
  }
  if (/No key with alias .* found in keystore/i.test(text)) {
    return "Configured key alias does not exist in the keystore. Re-add the keystore with the correct alias, or leave it blank when the keystore has exactly one alias so it can be auto-detected.";
  }
  if (/Invalid keystore password|saved store password does not open this keystore/i.test(text)) {
    return "Invalid keystore password. The saved store password does not open this keystore.";
  }
  if (/Invalid key password|Cannot recover key/i.test(text)) {
    return "Invalid key password for the selected alias. Update the key password in Settings.";
  }
  if (/Corrupted or unsupported keystore|Invalid keystore format|Unrecognized keystore format/i.test(text)) {
    return "Corrupted or unsupported keystore file. Upload a valid JKS or PKCS12 keystore.";
  }
  if (/No signing aliases found/i.test(text)) {
    return "No signing aliases found in the keystore. Upload a keystore containing a private key entry.";
  }
  if (/keystore password was incorrect/i.test(text)) {
    return "Signing keystore password is incorrect. Update the keystore in Settings (the store or key password saved doesn't match this .keystore file).";
  }
  if (/Failed to read key .* from store.*password.*incorrect/i.test(text)) {
    return "Signing key password is incorrect. Update the keystore in Settings.";
  }
  if (/EACCES|permission denied/i.test(text)) return "Permission denied while building — check keystore/file permissions.";
  if (/ENOSPC|no space left on device/i.test(text)) return "GitHub runner ran out of disk space.";
  if (/npm ERR!.*(ETARGET|ENOTFOUND|EAI_AGAIN)/i.test(text)) return "npm dependency resolution failed on the runner.";
  const gradle = text.match(/Execution failed for task '([^']+)'\.\s*\n?\s*>\s*([^\n]+)/);
  if (gradle) return `Gradle task ${gradle[1]} failed: ${gradle[2].trim().slice(0, 200)}`;
  return undefined;
}
