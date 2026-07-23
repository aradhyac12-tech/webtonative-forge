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
    throw new Error(`GitHub file write failed (${put.status})`);
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

export async function dispatchWorkflow(
  g: GH,
  repo: string,
  workflowFilename: string,
  inputs: Record<string, string>,
): Promise<void> {
  const d = await gh(
    g,
    `/repos/${g.login}/${repo}/actions/workflows/${workflowFilename}/dispatches`,
    {
      method: "POST",
      body: JSON.stringify({ ref: "main", inputs }),
    },
  );
  if (d.status >= 300) {
    throw new Error(`Workflow dispatch failed (${d.status})`);
  }
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
): Promise<string> {
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
  if (!res.ok) return `(logs unavailable: ${res.status})`;
  const text = await res.text();
  const lines = text.split("\n");
  return lines.slice(-200).join("\n");
}
