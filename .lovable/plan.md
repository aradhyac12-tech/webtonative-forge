Plan to fix the Android signing pipeline only:

1. Confirmed current build error

- The latest Android build fails during `:app:packageRelease`.
- The log shows: `No key with alias ... found in keystore`.
- So the immediate issue is an alias mismatch: the saved signing alias is not present in the uploaded keystore.

2. Add a preflight signing validation step in the Android GitHub workflow

- Insert a new step after `Decode keystore` and before `Gradle build`.
- Use Java `keytool` on the GitHub runner to validate the keystore before Gradle starts.
- The step will:
  - Confirm `project/android/app/release.keystore` exists and is non-empty.
  - Validate the keystore/store password by listing the keystore.
  - Extract all aliases from the keystore.
  - Validate the configured alias exists.
  - If the configured alias is missing and exactly one alias exists, auto-select that alias for the Gradle build.
  - If multiple aliases exist and the configured alias is missing, stop immediately with a clear message listing available aliases.
  - Validate the key password by forcing private-key access with `keytool` before packaging.
  - Detect corrupted/unreadable keystore files separately from bad passwords.

3. Make Gradle use the validated alias

- Write the validated/auto-detected alias to a temporary environment file inside the workflow.
- Update the `Gradle build` step to use the validated alias instead of blindly passing the saved alias.
- Never run `./gradlew assembleRelease` if signing validation fails.

4. Generate signing diagnostics in CI logs

- Add a structured diagnostics block to the workflow logs with:
  - Keystore file presence/size.
  - Store password validation result.
  - Alias count and alias names.
  - Configured alias match result.
  - Auto-detected alias result when applicable.
  - Key password validation result.
  - Final alias passed to Gradle.
- No secret values will be printed.

5. Improve Android failure summaries shown in the website

- Update the existing backend log summarizer to recognize:
  - Missing alias.
  - Multiple aliases requiring user selection.
  - Invalid store password.
  - Invalid key password.
  - Corrupted/unreadable keystore.
  - Missing decoded keystore.
- Keep the frontend unchanged; the existing build detail screen will display the clearer `error_summary` and diagnostics log chunk.

6.also verify Before starting any Android build, automatically execute the complete native project preparation pipeline exactly as a developer would.

&nbsp;

The platform must automatically:

&nbsp;

- Install project dependencies ("npm install", "bun install", or "pnpm install" as appropriate).

- Detect the package manager automatically.

- Verify Node.js, Java, Gradle, Android SDK, and Capacitor versions.

- Run "npx cap sync".

- If the Android project does not exist, run "npx cap add android".

- If it exists, synchronize all Capacitor plugins, assets, permissions, and native configuration.

- Automatically regenerate native resources (icons, splash screens, manifests, Capacitor config, plugin registration, Gradle files) when required.

- Validate "capacitor.config.*", "AndroidManifest.xml", Gradle configuration, package name, signing configuration, deep links, intent filters, permissions, Firebase configuration, and plugin compatibility.

- Verify that all native plugins are installed and registered correctly.

- Detect missing Android SDK packages and install them automatically when possible.

- Clean previous build artifacts ("gradlew clean") before release builds.

- Perform pre-build diagnostics and stop immediately if any required configuration is missing.

- Generate a detailed validation report before invoking Gradle.

- Only begin APK/AAB generation after all synchronization and validation steps complete successfully.

&nbsp;

The system must reproduce the essential Capacitor/Android Studio preparation workflow automatically so users do not need to manually run commands such as "npx cap sync", "npx cap add android", "gradlew clean", or perform native project synchronization themselves.

Files to change:

- `src/lib/android-workflow.ts` — add the signing validation preflight and pass the validated alias to Gradle.
- `src/lib/github.server.ts` — improve log summary detection for signing validation failures.

Note: “If multiple aliases exist, let the user choose one” cannot be fully implemented without changing the app/settings UI. Since you asked not to modify application code, this plan will stop early and show the available aliases so the existing keystore setting can be corrected. If you want a real dropdown chooser, that requires a small settings UI change in a separate step.