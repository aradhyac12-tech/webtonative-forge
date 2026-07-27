## Plan

### 1. Keep Android OAuth scope isolated
- Do not change UI, web Google OAuth, backend redirect allow-list values, or unrelated auth code.
- Treat `duospace://auth` as the expected native callback and only diagnose/repair Android callback handling and build output.

### 2. Add Android OAuth crash diagnostics to the generated APK/build
- Extend the Android workflow to scan the uploaded project for:
  - `AndroidManifest.xml`, `MainActivity`, Capacitor App plugin registration
  - `App.addListener('appUrlOpen')`
  - `Auth.tsx`, auth callback/redirect files, and `exchangeCodeForSession()` usage when present in the uploaded source
  - backend client initialization and session persistence keys, without printing token values
- Inject build-time-only sanitized diagnostics into the generated release APK:
  - native Activity lifecycle breadcrumbs: create/start/resume/newIntent/pause/stop/destroy
  - callback URL breadcrumbs: scheme/host/path and param names only, never OAuth codes/access/refresh tokens
  - JS error/unhandled rejection capture around callback processing
  - duplicate callback detection
  - session persistence success/failure markers
  - navigation/reload markers after the callback
- Add an Android release smoke probe in the workflow:
  - build the actual release APK
  - install it on an emulator
  - start the app, record PID/process state
  - fire the native callback intent with a sanitized test URL shaped like `duospace://auth?code=...`
  - capture logcat, ActivityManager, Chromium/WebView, Capacitor, and crash/tombstone lines
  - verify whether the process restarts, the callback fires once, and the WebView remains alive
- Store the result as `android-oauth-runtime-report.txt` and include its key failure line in the build failure summary.

### 3. Capture real-device Google OAuth callback diagnostics safely
- Add a public runtime diagnostic endpoint that accepts only sanitized callback-stage events for a build and writes them into that build’s logs.
- The injected diagnostics will post stages such as `appUrlOpen`, `exchange-start`, `exchange-error`, `session-persisted`, `navigation`, `unhandledrejection`, or `activity-recreated`.
- It will never send full callback URLs, OAuth codes, access tokens, refresh tokens, cookies, or auth headers.
- This lets the next DuoSpace APK run report the exact stage/exception from the real Google account-selection flow, instead of guessing from TypeScript checks.

### 4. Make build status update even when the website is closed
- Add a `/api/public/.../finalize` endpoint for GitHub Actions completion.
- The workflow will call it at the end of every Android run.
- The endpoint will not trust the caller’s status blindly; it will verify the stored build row, repo, run id, and run name through GitHub before updating the database.
- On success it finalizes the artifact immediately; on failure it downloads logs and writes the actionable summary.
- Keep the existing manual refresh path as a fallback.
- Reduce visible delay in the app by invalidating/refetching status more aggressively and using backend-driven completion instead of waiting for the user to keep the page open.

### 5. Store only APK/IPA as downloadable artifacts
- Split GitHub artifacts so diagnostics are separate from the APK artifact.
- Update Android artifact handling to extract the actual `.apk` from the GitHub artifact ZIP and store only `<build-id>.apk` in build storage.
- Keep diagnostic reports in logs/diagnostic artifacts, not as the user’s download.
- Keep iOS downloads as `.ipa` only and verify no ZIP wrapper is exposed.

### 6. Verification before claiming fixed
- Validate the generated workflow syntax and embedded shell scripts.
- Trigger a new DuoSpace Android release build.
- Confirm the app stores/downloads a real `.apk`, not a ZIP.
- Confirm the build reaches success/failure without the website staying open.
- Review the generated OAuth runtime report/logcat output.
- If the Google callback still terminates the process, use the captured exception/stage to fix that exact crash rather than changing redirect URLs blindly.