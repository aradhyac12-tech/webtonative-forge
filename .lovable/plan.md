## What I verified

- `dispatchWorkflow` in `src/lib/github.server.ts` throws `Workflow dispatch failed (422)` and **discards GitHub's response body**, so the actual reason is currently invisible. GitHub returns 422 for dispatch in a few distinct cases, and we can't tell which one without the body.
- The dispatch hardcodes `ref: "main"` — if the build repo's default branch is not `main` (or `main` has no commit yet), GitHub answers 422.
- The workflow YAML is written to the repo (`upsertFile`) and dispatched immediately in the same request. GitHub needs a moment to index a newly added/changed workflow; dispatching before indexing (or against a stale indexed copy that lacks the newer inputs such as `logo_url` / `node_version`) returns 422 `Unexpected inputs provided`.
- All inputs are sent as strings from `pipeline.functions.ts`; `logo_url` is sent as `""` when there's no logo — an empty-string input for a non-required input is accepted, but any input not declared in the indexed workflow is not.

Diagnosis is therefore: 422 is a dispatch-contract problem (branch ref, workflow indexing/stale inputs), not a build problem. The first step of the fix is to surface GitHub's own message so it can never again be a guess.

## Plan

### 1. Make dispatch failures self-explanatory and self-healing (`src/lib/github.server.ts`)

- Include GitHub's response body in every thrown error (`dispatchWorkflow`, `upsertFile`, `putSecret`, `ensureRepo`) so the UI shows e.g. "Unexpected inputs provided: ..." or "No ref found for: main".
- Resolve the repo's real default branch via `GET /repos/{owner}/{repo}` and dispatch against that instead of hardcoded `main`.
- If the default branch has no commits, create the initial commit (the workflow upsert already can) and re-resolve.
- After writing the workflow file, poll `GET /repos/.../actions/workflows/{file}` until the workflow is registered (bounded retries), then dispatch.
- Retry dispatch with backoff on 422 `Unexpected inputs provided` and on 404 (workflow not yet indexed) — up to ~5 attempts — after re-upserting the workflow file.
- Add `listWorkflowInputs`: read the declared `workflow_dispatch` inputs from the repo copy of the YAML and drop/patch any input the indexed workflow doesn't declare, so an older cached workflow can never hard-fail a dispatch.
- Ensure Actions are enabled on the repo (`PUT /repos/.../actions/permissions`) and the workflow isn't disabled (`PUT .../workflows/{file}/enable`), both of which also produce dispatch errors.

### 2. Universal pre-build sync & validation in the Android workflow (`src/lib/android-workflow.ts`)

Replace the single "Install & validate" step with an ordered, reporting pipeline that works for any uploaded web project (Capacitor or not):

1. **Environment report** — Node, package manager, Java, Gradle, `ANDROID_HOME`, SDK packages, Capacitor CLI/core versions; install missing SDK packages via `sdkmanager` when possible.
2. **Project detection** — detect package manager from lockfile, detect `capacitor-full` / `capacitor-partial` / `web-app`, detect the real web output dir from `capacitor.config.*` or common build outputs (`dist`, `build`, `out`, `www`).
3. **Dependency install** — install with the detected PM, fall back to `npm install --legacy-peer-deps`, then ensure `@capacitor/core`, `@capacitor/cli`, `@capacitor/android` exist at compatible major versions (auto-align mismatched Capacitor majors).
4. **Web build** — run the project's build script when present; fall back to existing assets and warn (never hard-fail on a missing build script).
5. **Native project generation/repair** — `cap init` when config missing, `cap add android` when `android/` missing, regenerate `android/` when it is present but broken (missing `gradlew`, missing manifest, missing `capacitor.settings.gradle`).
6. **Asset + plugin sync** — generate icons/splash with `@capacitor/assets` when a logo is present or detected, then `cap sync android` and verify every installed Capacitor plugin appears in `android/capacitor.settings.gradle` / `capacitor.build.gradle`; re-run sync once if a plugin is missing.
7. **Config validation with auto-repair** — verify and fix where safe: `applicationId`/`namespace` match the requested bundle ID, `AndroidManifest.xml` well-formedness, required permissions implied by installed plugins (camera, mic, storage/file picker, notifications, biometric, background tasks), `google-services.json` presence + Gradle plugin wiring when Firebase deps are detected, and `minSdk`/`compileSdk` floors required by the installed plugins.
8. **Deep links / OAuth intent filters** — derive schemes from `capacitor.config.*` (`appId`, `server.hostname`, custom `androidScheme`), from the bundle ID, and from any detected auth SDK (Supabase / Firebase / Auth0 / Clerk / Cognito). Inject the `<intent-filter>` entries for the custom scheme and any App Link host into `AndroidManifest.xml` if absent, so native OAuth/PKCE callbacks return to the app instead of the browser.
9. **Signing preflight** — keep the existing `keytool` validation (keystore presence, store password, alias enumeration, single-alias auto-select, key password).
10. **Clean** — `gradlew clean` before release packaging.
11. **Diagnostics report** — write every check, its result, and every auto-fix applied to `android-prebuild-report.txt`, echo it into the log with a clear `PREBUILD_VALIDATION_PASSED` / `PREBUILD_VALIDATION_FAILED: <reason>` marker, and abort before Gradle if any blocking issue remains.

### 3. Post-build APK verification (same workflow, after `assembleRelease`)

- Locate the release APK, verify the signature with `apksigner verify --print-certs` (fall back to `jarsigner -verify`).
- Use `aapt2 dump badging`/`xmltree` on the APK to assert: expected `package` / `versionCode`, the deep-link intent filters and every derived URL scheme (generic — whatever scheme the project declares, e.g. `duospace://auth`), `BridgeActivity`/`MainActivity` presence, and that plugin classes are registered.
- Emit `APK_VERIFICATION_PASSED` / `APK_VERIFICATION_FAILED: <reason>`; fail the job on verification failure so a partially functional APK is never published, and upload both report files alongside the APK artifact.

### 4. Surface everything in the app (`src/lib/github.server.ts` summarizer)

- Extend `summarizeFailure` to recognize the new markers (`PREBUILD_VALIDATION_FAILED`, `APK_VERIFICATION_FAILED`), plus common Capacitor/Gradle/SDK failures (missing SDK licence, Capacitor major mismatch, missing `google-services.json`, AndroidManifest merge conflict, unsupported Node for a dependency).
- Prefer the pre-build/verification report step file when choosing which log to tail, so the build detail page shows the actionable report rather than a generic Gradle stack trace.

### Technical notes

- Everything stays in the CI workflow YAML plus the two server helpers; the build UI is unchanged and no schema change is needed.
- All detection is derived from the uploaded project (config files, lockfiles, dependency list) — no hardcoded app names, bundle IDs, or schemes — so it applies to any project, not one specific APK.
- Auto-repairs are limited to idempotent, safe rewrites (manifest additions, Gradle property alignment, regenerated native folder); anything ambiguous aborts with an explicit reason instead of guessing.
