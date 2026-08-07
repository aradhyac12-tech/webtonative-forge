# Production hardening pass — plugin registration, Browser plugin, pipeline, dashboard

No UI redesign. No feature removal. Changes stay inside the workflow generators, the CI-facing server helpers, and the orchestration layer.

## What is verified today

- Plugin verification runs only after `cap sync` and aborts with `SYNC_VALIDATION_FAILED: these Capacitor plugins were not registered…` (`src/lib/android-workflow.ts:832`).
- The plugin set is built by scanning `package.json` plus **every** `node_modules` entry matching `@capacitor/*`, `@capacitor-community/*`, or `capacitor-*` that has an `android/` folder (:793-815).
- Registration is proven by a plain substring search of the package name across `capacitor.settings.gradle`, `capacitor.build.gradle`, and `capacitor.plugins.json` (:816-824).
- `capacitor.plugins.json` presence is only a warning (:836), while the APK check later hard-fails when it is absent (:1529).
- Auto-install already covers Browser/App on any OAuth signal, and the 12-stage Browser trace already repairs and re-syncs (:684-704, :1024-1039).

That combination is the most likely source of the false failure: the detected set can include packages that Capacitor legitimately does not register (no `@CapacitorPlugin` class, iOS-only, or a nested/duplicated copy under another package's `node_modules`), and the substring proof can miss a plugin registered under its Gradle slug when the raw package name is absent. Confirming which of the two fires is step 1 — the fix is not guessed.

## 1. Plugin detection and registration (root fix)

- Replace the heuristic set with Capacitor's own resolution: run `npx cap ls android` and read the plugin list Capacitor itself reports, cross-checked against each candidate package's `package.json` `capacitor.android` block. A package without that block is not a plugin and must never fail the build.
- Ignore nested `node_modules` copies and packages whose `android/` folder has no `src/main` sources.
- Prove registration structurally instead of by substring: parse `capacitor.settings.gradle` include names, `capacitor.build.gradle` project dependencies, and the class list in `capacitor.plugins.json`; match on the Gradle slug (`@capacitor/browser` → `capacitor-browser`) as well as the package name.
- Repair ladder before any failure: reinstall the missing package at the core major → `cap sync` → `cap update android` → clean `android/` regeneration + `cap add` + `cap sync`. Only after all four fail does the build stop, and the abort message lists per-plugin evidence (declared / installed / gradle / plugins.json / dex).
- Make `capacitor.plugins.json` a hard gate before Gradle whenever at least one real plugin is resolved, and keep the existing APK-level packaging check.

## 2. Browser plugin

Keep the existing 12-stage trace, and extend the repair loop so it can also run the `cap update`/regenerate ladder above rather than only install + re-sync. Add a final assertion that `BrowserPlugin` is present in the APK's `capacitor.plugins.json` **and** in the dex, failing the build with an explicit message when it is not.

## 3. Android pipeline order

Reassert the required sequence with named steps, filling the current gaps: `cap init` when `capacitor.config.*` is absent, lockfile repair and `npm dedupe` on integrity errors, Gradle wrapper regeneration when `gradlew`/`gradle-wrapper.properties` is broken, and `MainActivity` presence/package-match validation with repair. Signing preflight, APK/AAB build, and artifact integrity verification stay as they are.

## 4. Framework and directory detection

Detection stays dynamic (no hardcoded `dist`/`build`/`.output/public`): resolve the build command from `package.json` scripts and the detected framework, then resolve the web directory by locating the newest emitted `index.html` after the build, and repair `capacitor.config` to match. Add explicit recognition for Angular's `dist/<project>/browser`, Nuxt, SvelteKit adapter-static, Ionic, and TanStack Start client output.

## 5. Auto-repair coverage

Missing `android/`, missing `capacitor.config`, broken Gradle, broken Manifest, broken MainActivity, and missing plugins each get a repair path that is attempted before any failure, and every repair is recorded in `android-build-report.txt` under a `REPAIR:` marker surfaced in the dashboard summary.

## 6. OAuth validation

Static, deterministic checks (no emulator): Browser + App installed and registered, custom scheme + `https` app-link intent filters present, `launchMode="singleTask"`, `appUrlOpen` bridge injected, and a warning when the project's Supabase/Firebase redirect config has no matching native scheme. Reported as an OAuth readiness block in the build report; missing Browser/App is fatal, the rest are warnings.

## 7. Dashboard and orchestration

- Surface a reason next to the disabled "Start Android Build" button (missing GitHub connection, no keystore, no source, invalid bundle ID) instead of a silently inert control.
- Show dispatch/push/repo failures with the underlying API status and a retry action; keep polling alive on transient errors (already partly done) and expose the retry count.
- Add an explicit "Retry build" action on a failed build that re-dispatches with the same inputs.
- Timeout + abort handling on all client calls so a hung request surfaces as a retryable error rather than "Unable to fetch".

## 8. CI/CD and diagnostics

Extend the existing Settings readiness check into a full preflight that also validates: workflow file present with `workflow_dispatch` on the resolved default branch, required secrets present, keystore decodable with the stored passwords, Codemagic app + signing profile reachable, and both storage buckets writable — each pass/fail with remediation text.

## Validation

- Regenerate both workflow YAMLs into a scratch dir, parse as YAML, `bash -n` every script block.
- Unit-exercise the new plugin-resolution and registration-proof scripts against fixtures: a real plugin, an iOS-only package, a nested duplicate, and a plugin missing from Gradle.
- Typecheck the project.
- Report per item: root cause, files changed, fix, validation result.

## Remaining manual actions

Apple signing credentials (API key, bundle id, provisioning) must be supplied by the workspace admin; everything else is automated.
