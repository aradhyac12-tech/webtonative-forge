import JSZip from "jszip";

export const MAX_COMPRESSED_BYTES = 500 * 1024 * 1024; // 500 MB
export const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const MAX_ENTRIES = 50_000;

const STRIP_PREFIXES = [
  "node_modules/",
  ".git/",
  "build/",
  ".next/",
  ".output/",
  ".turbo/",
  ".cache/",
  "android/.gradle/",
  "android/app/build/",
  "android/build/",
  "ios/Pods/",
  "ios/build/",
  "ios/DerivedData/",
];

const STRIP_SUFFIXES = [".DS_Store"];

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

export type ProjectKind = "capacitor-full" | "capacitor-partial" | "web-app";

export type NodeRequirement = {
  raw: string;
  source: "engines" | "nvmrc";
  major?: number;
  /** true when the spec pins a single major (e.g. "22", "22.x", "^22.5.0", or an .nvmrc line). */
  strict: boolean;
};

export type ValidationOk = {
  ok: true;
  originalSize: number;
  strippedSize: number;
  strippedZip: Blob;
  entryCount: number;
  strippedEntryCount: number;
  projectKind: ProjectKind;
  capacitorVersion?: string;
  packageName?: string;
  appName?: string;
  bundleId?: string;
  webDir?: string;
  hasAndroid: boolean;
  hasIos: boolean;
  hasCapConfig: boolean;
  nodeRequirement?: NodeRequirement;
  warnings: string[];
};

export type ValidationErr = { ok: false; reason: string };
export type ValidationResult = ValidationOk | ValidationErr;
export type ProgressFn = (phase: string, pct?: number) => void;

/**
 * Validate a project zip and produce a stripped version ready to upload.
 * Accepts full Capacitor projects, partial Capacitor projects, or plain web apps
 * (Vite/CRA/Next/etc.) — the workflow will auto-inject Capacitor when needed.
 */
export async function validateAndStrip(
  file: File,
  onProgress?: ProgressFn,
): Promise<ValidationResult> {
  if (!/\.zip$/i.test(file.name)) {
    return { ok: false, reason: "File must be a .zip archive." };
  }
  if (/\.(apk|aab|ipa)$/i.test(file.name)) {
    return {
      ok: false,
      reason:
        "This looks like a compiled mobile binary. We build from source only — upload the project zip instead.",
    };
  }
  if (file.size > MAX_COMPRESSED_BYTES) {
    return {
      ok: false,
      reason: `Zip is ${(file.size / 1024 / 1024).toFixed(0)} MB — larger than the 500 MB limit. Strip node_modules/build folders locally before zipping.`,
    };
  }

  onProgress?.("Reading zip", 5);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (e) {
    return { ok: false, reason: `Could not read zip: ${(e as Error).message}` };
  }

  const files = Object.values(zip.files);
  if (files.length > MAX_ENTRIES) {
    return {
      ok: false,
      reason: `Zip has ${files.length} entries (max ${MAX_ENTRIES}). Suspicious archive — refusing to process.`,
    };
  }

  // Detect wrapper directory
  const topDirs = new Set<string>();
  for (const f of files) {
    const p = normalize(f.name);
    const first = p.split("/")[0];
    if (first) topDirs.add(first);
  }
  const wrapperPrefix =
    topDirs.size === 1 && !files.some((f) => normalize(f.name) === Array.from(topDirs)[0])
      ? Array.from(topDirs)[0] + "/"
      : "";

  const rel = (name: string) => {
    const n = normalize(name);
    return wrapperPrefix && n.startsWith(wrapperPrefix) ? n.slice(wrapperPrefix.length) : n;
  };

  let uncompressedTotal = 0;
  let hasPackageJson = false;
  let hasCapConfig = false;
  let hasAndroid = false;
  let hasIos = false;
  let hasIndexHtml = false;
  let hasPubspec = false;
  let hasReactNative = false;
  let packageJsonEntry: JSZip.JSZipObject | null = null;
  let capConfigEntry: JSZip.JSZipObject | null = null;
  let nvmrcEntry: JSZip.JSZipObject | null = null;
  const seenDirs = new Set<string>();

  for (const f of files) {
    if (f.dir) continue;
    const usize: number =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (f as any)?._data?.uncompressedSize ?? 0;
    uncompressedTotal += usize;
    if (uncompressedTotal > MAX_UNCOMPRESSED_BYTES) {
      return {
        ok: false,
        reason: `Uncompressed contents exceed 2 GB — refusing to process (possible zip bomb).`,
      };
    }
    const r = rel(f.name);

    if (/^[^/]+\.(apk|aab|ipa)$/i.test(r)) {
      return {
        ok: false,
        reason: `Found compiled binary "${r}" in the zip. Upload source code, not built artifacts.`,
      };
    }

    if (r === "package.json") { hasPackageJson = true; packageJsonEntry = f; }
    if (r === "capacitor.config.ts" || r === "capacitor.config.json" || r === "capacitor.config.js") {
      hasCapConfig = true;
      capConfigEntry = f;
    }
    if (r === "index.html" || r === "public/index.html") hasIndexHtml = true;
    if (r === "pubspec.yaml") hasPubspec = true;
    if (r === "metro.config.js" || r === "app.json" && !hasCapConfig) {
      // hint of RN — will confirm below
    }
    if (r.startsWith("android/")) hasAndroid = true;
    if (r.startsWith("ios/")) hasIos = true;

    // track top-ish dirs
    const parts = r.split("/");
    if (parts.length > 1) seenDirs.add(parts[0]);
  }

  // Reject Flutter
  if (hasPubspec) {
    return {
      ok: false,
      reason:
        "This looks like a Flutter project. We only build Capacitor / web-app projects — Flutter support isn't available.",
    };
  }

  // Parse package.json (needed for RN detection + Capacitor version + build script)
  type Pkg = {
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  let pkg: Pkg | null = null;
  if (packageJsonEntry) {
    try {
      pkg = JSON.parse(await packageJsonEntry.async("string")) as Pkg;
    } catch {
      /* not fatal */
    }
  }
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (deps["react-native"] && !hasCapConfig) {
    hasReactNative = true;
  }
  if (hasReactNative) {
    return {
      ok: false,
      reason:
        "This looks like a React Native project. We only build Capacitor / web-app projects.",
    };
  }

  // Classify project kind
  let projectKind: ProjectKind;
  if (hasCapConfig && (hasAndroid || hasIos)) {
    projectKind = "capacitor-full";
  } else if (hasCapConfig) {
    projectKind = "capacitor-partial";
  } else if (hasPackageJson || hasIndexHtml) {
    projectKind = "web-app";
  } else {
    return {
      ok: false,
      reason:
        "Couldn't detect a Capacitor project or a web app. Include a package.json (with a build script) or an index.html at the root of the zip.",
    };
  }

  const capacitorVersion =
    deps["@capacitor/core"] ?? undefined;

  // App name — Capacitor config first, else package.json
  let appName: string | undefined;
  let bundleId: string | undefined;
  if (capConfigEntry) {
    try {
      const capText = await capConfigEntry.async("string");
      const mId = capText.match(/appId\s*[:=]\s*['"`]([^'"`]+)['"`]/);
      if (mId) bundleId = mId[1];
      const mName = capText.match(/appName\s*[:=]\s*['"`]([^'"`]+)['"`]/);
      if (mName) appName = mName[1];
      const mWeb = capText.match(/webDir\s*[:=]\s*['"`]([^'"`]+)['"`]/);
      if (mWeb && !seenDirs.has(mWeb[1])) seenDirs.add(mWeb[1]);
    } catch {
      /* ignore */
    }
  }
  if (!appName) appName = pkg?.name;

  // Guess webDir (only meaningful for web-app / capacitor-partial)
  const knownWebDirs = ["www", "dist", "build", "out", "public"];
  let webDir: string | undefined;
  for (const d of knownWebDirs) {
    if (seenDirs.has(d)) { webDir = d; break; }
  }
  if (!webDir && projectKind === "web-app") {
    // Guess by build script content
    const buildScript = pkg?.scripts?.build ?? "";
    if (/vite/.test(buildScript) || deps["vite"]) webDir = "dist";
    else if (deps["react-scripts"]) webDir = "build";
    else if (deps["next"]) webDir = "out";
    else if (deps["@angular/cli"]) webDir = "dist";
    else webDir = "dist";
  }
  if (!webDir) webDir = "www";

  onProgress?.("Stripping heavy folders", 40);

  const outZip = new JSZip();
  let strippedEntries = 0;
  let processed = 0;
  const total = files.length;

  for (const f of files) {
    processed++;
    if (processed % 250 === 0) {
      onProgress?.("Stripping heavy folders", 40 + Math.floor((processed / total) * 40));
    }
    if (f.dir) continue;
    const r = rel(f.name);
    // Never strip the detected webDir if it's a static-only project (no package.json)
    const preserveWebDir = !hasPackageJson && webDir && r.startsWith(`${webDir}/`);
    if (!preserveWebDir) {
      if (STRIP_PREFIXES.some((p) => r.startsWith(p))) continue;
      // strip `dist/` only if it's not the source root
      if (r.startsWith("dist/") && hasPackageJson) continue;
    }
    if (STRIP_SUFFIXES.some((s) => r.endsWith(s))) continue;
    if (r.includes("/node_modules/")) continue;

    const content = await f.async("uint8array");
    outZip.file(r, content);
    strippedEntries++;
  }

  onProgress?.("Compressing", 85);
  const strippedZip = await outZip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  onProgress?.("Done", 100);

  const warnings: string[] = [];
  if (projectKind === "web-app") {
    warnings.push(
      `No Capacitor detected — we'll auto-add Capacitor in the cloud build (webDir: ${webDir}).`,
    );
  } else if (projectKind === "capacitor-partial") {
    warnings.push("Capacitor config found but native folders missing — we'll add them in the cloud build.");
  }
  if (!bundleId) {
    warnings.push("No bundle ID detected — set one on the next step (required for iOS).");
  }

  return {
    ok: true,
    originalSize: file.size,
    strippedSize: strippedZip.size,
    strippedZip,
    entryCount: files.length,
    strippedEntryCount: strippedEntries,
    projectKind,
    capacitorVersion,
    packageName: pkg?.name,
    appName,
    bundleId,
    webDir,
    hasAndroid,
    hasIos,
    hasCapConfig,
    warnings,
  };
}
