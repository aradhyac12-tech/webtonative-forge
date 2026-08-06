# Final stabilization pass — build platform reliability

The Android and iOS pipeline YAML (framework/package-manager detection, repair-first dependency system with MAJOR-only Capacitor compatibility, intent-based plugin install incl. Browser/App, webDir detection and repair, `cap add`/`cap sync`, post-sync `capacitor.plugins.json` verification, APK plugin verification, deep links/intent filters/`launchMode=singleTask`, signing preflight, APK/AAB + IPA build, diagnostics reports) is already implemented and validated in `src/lib/android-workflow.ts` and `src/lib/ios-workflow.ts`. This pass fixes the remaining weak layer: the **orchestration and status/artifact plumbing** in the app, which is where "Unable to fetch", stuck builds and missing artifacts actually come from.

## Verified issues to fix

1. **"Unable to fetch" / stuck build status.** `refreshAndroid` and `refreshIos` (`src/lib/pipeline.functions.ts:227-337`) throw raw on artifact download problems (`No APK artifact produced`, `Codemagic get build failed`, storage upload error). The thrown server function becomes a failed request in the browser, the row stays non-terminal, and polling repeats the same throw forever.
2. **iOS has no background finalization.** Android has `src/routes/api/public/build-finalize.ts`; iOS has no equivalent, so a Codemagic build only completes while the user keeps the page open.
3. **Generic iOS failure summaries.** iOS failures always report `Codemagic build <status>.` — the log tail is stored but the markers the iOS workflow emits (`IOS_VALIDATION_FAILED`, `IOS_SIGNING_VALIDATION_FAILED`, and the shared dependency/plugin markers) are never parsed into `error_summary`.
4. **Fragile IPA artifact pickup.** Only an artefact whose name ends in `.ipa` is accepted; a zipped or differently named Codemagic artefact yields a hard throw instead of extraction/fallback.
5. **No retry on transient GitHub/Codemagic API calls.** A single 5xx or network blip surfaces as a user-facing error.

## Changes

**A. Resilient status refresh (`src/lib/pipeline.functions.ts`)**
- Wrap the terminal-handling section of both refresh paths in try/catch. On failure: keep the build non-terminal, record the reason in `build_logs`, and return the last known status plus a `transient` flag instead of throwing — no more "Unable to fetch".
- Count consecutive finalization failures; after a threshold, mark the build `failed` with a precise summary rather than looping.
- Preserve all existing success behaviour and `supabaseAdmin` usage.

**B. Transient-error retry (`src/lib/github.server.ts`, `src/lib/codemagic.server.ts`)**
- Small shared retry helper (3 attempts, exponential backoff) applied to run/build status reads and artifact downloads; retry only on network errors and 429/5xx, never on 401/404/422.

**C. iOS background finalization (`src/routes/api/public/build-ios-finalize.ts`, new)**
- Mirror of the Android endpoint: `buildId` + `diagnostic_token` auth, reads the Codemagic build, uploads the IPA, writes terminal status. The iOS workflow calls it in a post-publish step so the build finalizes even when the user closes the tab.

**D. IPA artifact resolution (`src/lib/codemagic.server.ts`)**
- Pick the `.ipa` artefact; if none, unwrap a `.zip`/archive artefact and extract the first `.ipa` inside (same shape as the Android APK-from-zip extraction). Only fail when no IPA exists after both paths.

**E. iOS failure diagnostics (`src/lib/github.server.ts` summary extractor, reused for Codemagic tails)**
- Run the Codemagic log tail through the same marker extractor used for Android so `IOS_VALIDATION_FAILED`, `IOS_SIGNING_VALIDATION_FAILED`, dependency and plugin markers become the `error_summary` shown on the build page.

**F. Preflight self-check surfaced in Settings**
- Extend the existing readiness check to verify, server-side: GitHub token validity and repo push permission, workflow file presence with a `workflow_dispatch` trigger on the resolved default branch, storage buckets reachable, and Codemagic app/token reachable — each reported as pass/fail with the exact remediation. This turns credential and permission problems into a readable checklist instead of a dispatch-time 401/422.

## Validation

- Regenerate both workflow files in a scratch dir, parse as YAML, `bash -n` every `run:`/`script:` block.
- Typecheck the project.
- Exercise the new iOS finalize route and the retry helper against simulated 500/429/success responses.

## Notes

No UI redesign, no auth/Supabase/Google config changes, no schema changes beyond reusing the existing `diagnostic_token`. Apple signing credentials still have to be supplied by the workspace admin — that remains the only unavoidable manual step for IPA output.
