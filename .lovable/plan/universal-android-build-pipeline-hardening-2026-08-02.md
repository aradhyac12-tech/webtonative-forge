# Universal Android build pipeline hardening

## What's actually breaking

The last build failed at step 9 ("Generate or repair native Android project") for a project whose `capacitor.config` declares `webDir: ".output/public"`, while the real build output was `public`:

```text
[error] The web assets directory (./.output/public) must contain an index.html file.
[error] ENOENT: .../android/app/src/main/assets/capacitor.plugins.json
PREBUILD_VALIDATION_FAILED: cap add android failed
```

Confirmed causes in `src/lib/android-workflow.ts`:

1. The "Build web assets" step resolves the real output directory into `RESOLVED_WEB_DIR`, but nothing ever writes that value back into an existing `capacitor.config.*`. `cap init --web-dir` only runs when no config exists, so a wrong `webDir` is never repaired.
2. Because `cap add android` internally runs copy+update, the copy failure cascades into the `capacitor.plugins.json` ENOENT — plugin state is being observed at the wrong moment (during `add`, not after `sync`).
3. The "Runtime OAuth callback smoke test" step boots an Android emulator and timed out after 15 minutes. CI must not perform runtime auth/device testing.
4. No AAB is produced; only `assembleRelease`.

## Plan

### 1. Repair `capacitor.config` webDir (new step, before native generation)
- Detect the config file (`.ts` / `.js` / `.json`), read its declared `webDir`.
- If the declared dir has no `index.html` and `RESOLVED_WEB_DIR` does, rewrite the `webDir` value in place (regex for TS/JS, JSON parse+write for JSON) and log the before/after.
- Create the config via `cap init` when missing, using `RESOLVED_WEB_DIR`.
- Hard-verify `RESOLVED_WEB_DIR/index.html` exists and abort with a precise message before any `cap` command touches it.

### 2. Stop generating a placeholder index.html
Current fallback fabricates an empty page, which produces a blank-screen APK. Replace with an abort listing: framework detected, build command run, directories probed, and directory listing of the project root.

### 3. Broaden webDir detection
Extend the candidate list with framework-aware ordering: `.output/public` (Nuxt), `.next` export/`out` (Next), `dist/browser` and `dist/<app>/browser` (Angular), `build/client` (Remix/TanStack), `.svelte-kit/output/client`, plus existing `dist build out www public dist/spa`. Also do a bounded `find` for any `index.html` no deeper than 3 levels, excluding `node_modules`/`android`/`ios`, as the last resort before failing.

### 4. Correct plugin verification timing
- Remove any plugin/`capacitor.plugins.json` expectation from the `cap add` step; treat `add` failures separately from `copy` failures by running `cap add android` alone, then `cap sync android`.
- After `cap sync android`: require `android/app/src/main/assets/capacitor.plugins.json` to exist and to list every `@capacitor/*` and `@capacitor-community/*` dependency; report the exact missing plugin names on failure.
- Re-verify packaged plugins inside the built APK (unzip `assets/capacitor.plugins.json`) in the existing verification step.

### 5. Auto-install commonly required plugins
Scan the source for usage of Browser, App, Haptics, Camera, Filesystem, Preferences, Push Notifications, Network, Geolocation; install any that are used but not declared in `package.json`, matching the installed `@capacitor/core` major version so no version mismatch occurs.

### 6. Remove runtime OAuth device testing from CI
Delete the `reactivecircus/android-emulator-runner` smoke-test step. Keep all static/compile-time OAuth work (manifest intent filters, launchMode, scheme/host registration, `MainActivity` handling, Browser plugin presence) and record in the diagnostics report that runtime OAuth is manual device testing.

### 7. Deep-link and OAuth checks stay non-destructive
Verification only — `launchMode="singleTask"`, VIEW/DEFAULT/BROWSABLE, `exported="true"`, scheme+host present, Browser plugin registered. Existing custom schemes, hosts, and callback URLs are preserved; missing pieces are added, existing pieces are never overwritten.

### 8. Build AAB alongside APK
Run `bundleRelease` with the same injected signing properties, upload the `.aab` as a separate artifact, and keep the APK as the primary download.

### 9. Diagnostics report
Emit one `android-build-report.txt` containing: framework, package manager, build command, declared vs resolved webDir, index.html path, capacitor config path, Capacitor/Gradle/Java/SDK versions, installed vs missing plugins, repaired files, signing status and resolved alias, APK/AAB signature verification, and artifact locations. Upload it on both success and failure.

## Technical notes

All changes are confined to `src/lib/android-workflow.ts` (the generated GitHub Actions YAML) plus the failure-summary patterns in `src/lib/github.server.ts` so `PREBUILD_VALIDATION_FAILED:` / `SYNC_VALIDATION_FAILED:` messages surface verbatim in the site UI. No UI, schema, or business-logic changes. The generated YAML will be validated locally (YAML parse + `bash -n` on every step) before finishing.
