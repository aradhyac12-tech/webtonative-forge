# Dependency preflight + Browser-plugin forensic trace

Two additions to the Android pipeline (`src/lib/android-workflow.ts`), plus log-surfacing in `src/lib/github.server.ts`. No OAuth, Supabase, Google, or UI changes.

## Part A — What the code shows today (verified reads)

- Dependency install (step "Detect project and install dependencies") detects npm/bun/pnpm/yarn, installs, and falls back to `npm install --legacy-peer-deps`. It does **not** run any post-install health check (`npm ls`), does not verify `node_modules` actually contains the declared packages, and does not check Gradle wrapper / Java / SDK / build-tools presence before Gradle runs.
- Capacitor alignment only prints the major versions of core/cli/android (`CAP_MAJORS=`); it never fails or repairs on mismatch.
- Plugin auto-install (step "Ensure required Capacitor plugins") adds `@capacitor/<plugin>` **only when a literal grep for the package name matches project source** (`grep -rIlF "@capacitor/browser" .`, excluding node_modules/android/ios/.git).
- Post-sync verification and the APK plugin check both iterate over **plugins declared in package.json**. A plugin that is neither declared nor grep-matched is invisible to every check — the build passes and the APK ships without it.

That combination is the most likely path to `Browser plugin is not implemented on android`, but the plan does not assume it: the trace below proves or disproves it with evidence at each stage.

## Part B — Browser plugin forensic trace (diagnostic only, no auto-fix)

New step **"Browser plugin forensic trace"**, run twice — once right after `cap sync android`, once after the APK is built — writing `browser-plugin-trace.txt` (uploaded as an artifact on success and failure). Each check prints PASS/FAIL with the exact file path and the evidence line:

1. `package.json` — is `@capacitor/browser` in dependencies/devDependencies? print the version range.
2. `node_modules/@capacitor/browser/package.json` — exists? print resolved version.
3. `node_modules/@capacitor/browser/android/` — native Android source present? list `src/main/java/**/BrowserPlugin.java`.
4. `cap sync android` exit code and full stdout captured verbatim (currently swallowed on retry).
5. `android/app/src/main/assets/capacitor.plugins.json` — exists? print it in full.
6. Does that file contain a `Browser` classpath entry (`com.capacitorjs.plugins.browser.BrowserPlugin`)?
7. `android/capacitor.settings.gradle` + `android/app/capacitor.build.gradle` — grep for `capacitor-browser`, print matching lines.
8. `MainActivity.java` — print the full file; assert `extends BridgeActivity`, assert no manual `registerPlugin` list that would replace auto-registration, and record whether the APKForge diagnostics injection altered the class declaration.
9. Built APK — `unzip -l` the assets dir, then `unzip -p assets/capacitor.plugins.json` and print it.
10. Built APK — `dexdump`/`unzip -l` scan for the `BrowserPlugin` class in the dex, print the hit or the absence.
11. Artifact identity — print APK path, sha256, build timestamp, and the run's `build_id`, so the installed APK can be matched against the built one.
12. Verdict line: `BROWSER_TRACE_VERDICT: <first failing stage> — <file path> — <evidence>`, or `BROWSER_TRACE_VERDICT: present end-to-end`.

The verdict is a report; the build is **not** silently repaired at this stage.

## Part C — Dependency verification stage (before any native step)

New step **"Verify dependencies and toolchain"**, placed after install and before the web build:

- Package manager detection reused from the existing step (`PM`, `INSTALL_CMD`).
- Verify every `dependencies` + `devDependencies` entry resolves in `node_modules`; list the missing ones by name.
- Install the missing set once with the detected package manager, then re-verify. Two attempts maximum.
- Health check: `npm ls --all --json` (or `pnpm list` / `yarn list` / `bun pm ls`), parsed for missing / invalid / duplicated / peer-incompatible entries; each is printed with the dependency path.
- Capacitor compatibility: require `@capacitor/core`, `@capacitor/cli`, `@capacitor/android` to be installed and share a major version; enumerate every installed `@capacitor/*` and `@capacitor-community/*` plugin with its installed version, and flag any plugin whose peer range excludes the installed core major.
- Toolchain: assert `java -version` (17+), `$ANDROID_HOME` platform-tools/build-tools present, `sdkmanager` licences accepted, and after native generation that `android/gradlew` is executable and `gradle-wrapper.properties` declares a version.
- On anything unresolvable: `PREBUILD_VALIDATION_FAILED: DEPENDENCY_VALIDATION_FAILED: <detail>` and stop before `cap add` / Gradle, with the full report uploaded.

Everything is written into the existing `android-build-report.txt` as a `== Dependency verification ==` section.

## Technical notes

- All pipeline changes are confined to the generated YAML in `src/lib/android-workflow.ts`; step ordering becomes: install → dependency+toolchain verification → web build → webDir repair → plugin ensure → `cap add` → `cap sync` → Browser trace #1 → native patching → Gradle clean/assemble/bundle → sign → verify → Browser trace #2 → final diagnostics.
- `src/lib/github.server.ts` gains summary patterns for `DEPENDENCY_VALIDATION_FAILED:` and `BROWSER_TRACE_VERDICT:` so the verdict shows in the site UI without opening GitHub.
- Generated YAML is validated locally (YAML parse + `bash -n` on each `run:` block) before finishing.
