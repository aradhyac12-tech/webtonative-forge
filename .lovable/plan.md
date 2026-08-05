# Universal Web-to-Native build platform hardening

Scope: the build pipeline only — `src/lib/android-workflow.ts`, `src/lib/ios-workflow.ts`, `src/lib/github.server.ts`, `src/lib/codemagic.server.ts`. No UI, auth, Supabase, or Google-config changes.

## Audit findings (verified in code)

1. **Browser plugin disappears at stage 1 — declaration.** `Ensure required Capacitor plugins` (android-workflow.ts:531-555) installs `@capacitor/browser` only when a literal `grep -rIlF "@capacitor/browser"` matches project source. An app that reaches the browser indirectly (Supabase/Firebase OAuth calls it through their SDK, or the project uses `window.open`) never matches, so the package is never added, `cap sync` never registers it, `capacitor.plugins.json` never lists it, and the APK ships without it — exactly the runtime `Browser plugin is not implemented on android`. Every downstream gate (post-sync check :634-665, APK packaged-plugin check) iterates over plugins **declared in package.json**, so an undeclared plugin is invisible to all of them. The forensic trace added last turn reports this but does not repair it.
2. **Dependency validator is fail-first, not repair-first** (:173-286). Hard `fail` on: any package still missing after two attempts, any Capacitor major mismatch, any declared-but-not-installed plugin, and any plugin whose `peerDependencies["@capacitor/core"]` range does not textually contain the core major (`>=7.0.0` with core 8 fails even though it is compatible). No dedupe, no lockfile check, no targeted reinstall of a broken package.
3. **iOS pipeline is far behind Android** (ios-workflow.ts, 93 lines): npm hardcoded, no framework/package-manager detection, no webDir detection or repair, fabricates a placeholder `index.html` (ships a blank app), `npx cap sync ios || true` swallows failures, no plugin ensure, no Info.plist URL-type / permission patching, no signing preflight, no diagnostics report.

## Part A — Browser plugin: repair, not just report

- Replace the literal-grep gate with **intent detection**: install a Capacitor plugin when the source references it *or* when a signal implies it. For Browser: any of `@supabase/supabase-js`, `firebase/auth`, `@auth0/`, `@clerk/`, `appwrite`, `signInWithOAuth`, `oauth`, `window.open`, or an existing deep-link/custom-scheme config. Same signal model for App (always, when native platform is generated), Preferences, Push Notifications, Camera, Filesystem, Geolocation, Network, Haptics, Splash Screen, Status Bar.
- Always install `@capacitor/app` and `@capacitor/browser` when the project has any OAuth signal — these are what make the native callback return to the app instead of staying in the browser.
- Install at the core major (`@^<coreMajor>`), then re-run `cap sync` so registration happens after the install.
- Post-sync gate is upgraded from "declared plugins" to "**declared ∪ installed in node_modules with an `android/` folder**", so a plugin present natively but undeclared is still verified.
- Keep the 12-stage forensic trace, and add an auto-repair loop: if stage 1/2 fails, install and re-sync once, then re-run the trace. Final verdict line records `repaired` vs `unrepairable`.

## Part B — Dependency system redesign (repair-first)

New order inside `Verify dependencies and toolchain`:

1. Detect package manager from lockfile (`bun.lockb`/`bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`) with `packageManager` field taking precedence; record which lockfile was used and whether it is missing/stale.
2. Install with the detected manager; on failure retry with the manager's legacy/relaxed flag, then npm `--legacy-peer-deps`.
3. Verify every declared dep resolves; install only the missing set; for a package whose folder exists but whose `package.json` is unreadable, remove the folder and reinstall that one package.
4. `npm dedupe` (or `pnpm dedupe` / `yarn dedupe`) when duplicates are detected, then re-verify.
5. Capacitor compatibility uses **official rules**: only the MAJOR of `@capacitor/core`, `/cli`, `/android`, `/ios` must match. Plugin minors/patches are free. Peer ranges are evaluated with real semver (parse the range, compare against the installed core version) instead of a substring regex — `>=7.0.0`, `^8.0.0 || ^9.0.0`, `*` all resolve correctly.
6. Mismatches are **repaired first**: reinstall the offending Capacitor package at `@^<coreMajor>`; only fail if the repair does not resolve it.
7. Failure is the last resort and always emits the full report; patch/minor differences never abort.

## Part C — Pipeline order and iOS parity

Android steps are reordered/named to match the required 1-25 sequence (validate → detect framework → detect PM → install → repair → verify → build web → detect assets → detect index.html → configure capacitor.config → generate native → repair native → patches → permissions → deep links → OAuth → signing → sync → verify plugins → verify native config → build APK/AAB → verify artifacts → diagnostics). Existing behaviour is preserved; this is grouping and ordering, not a rewrite.

`src/lib/ios-workflow.ts` gains the Android equivalents:
- framework + package-manager detection and the same install/repair/verify stage;
- real webDir resolution (no assumed `dist`/`build`/`.output/public`), `capacitor.config` webDir repair, hard abort when no `index.html` is produced — the fabricated placeholder page is removed;
- plugin ensure with the same intent detection, `cap sync ios` failing loudly (no `|| true`);
- Info.plist patching: URL types / custom schemes, associated-domain-safe merge, and only the permission usage strings the detected plugins require — existing entries are never overwritten;
- signing preflight before `build-ipa` (API key present, bundle id matches, profile fetched) and IPA verification after;
- `ios-build-report.txt` uploaded as an artifact on success and failure.

## Part D — Diagnostics

One report per platform containing: framework, package manager + lockfile, install/repair actions, missing→installed list, dedupe results, full Capacitor package inventory with compatibility verdict, detected/repaired webDir, build command, native project generated vs repaired, plugin registration table (declared / installed / in `capacitor.plugins.json` / in APK dex), deep-link + intent-filter + launchMode verdict, signing status, artifact verification (APK/AAB/IPA), per-step timings, issues detected, fixes applied, remaining manual actions. `src/lib/github.server.ts` and `codemagic.server.ts` surface the new markers (`DEPENDENCY_REPAIRED:`, `PLUGIN_AUTOINSTALL:`, `BROWSER_TRACE_VERDICT:`, `IOS_VALIDATION_FAILED:`) in the dashboard summary.

## Technical notes

All changes live in the generated YAML strings plus the log-summary patterns. Generated YAML is validated locally (YAML parse + `bash -n` on every `run:`/`script:` block) and the project typechecked before finishing. No OAuth, Supabase, Google, schema, or UI changes.
