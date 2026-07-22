## Scope

Extend APKForge with two capabilities:
1. **iOS builds via Codemagic** (shared workspace account, App Store Connect API key signing)
2. **Auto-Capacitor injection** for web-ish zips that don't already have Capacitor

## Part 1 — Auto-Capacitor injection (runs before dispatch)

Extend `src/lib/validate-zip.ts` project detection to classify the zip into one of:

- `capacitor-full` — has `capacitor.config.*` + `android/` and/or `ios/` (today's happy path, unchanged)
- `capacitor-partial` — has `capacitor.config.*` but missing the target platform folder → run `npx cap add <platform>` in the workflow
- `web-app` — no Capacitor, but detectable web project. Detection order:
  1. Static: has `index.html` at root or in `dist/`/`build/`/`public/` with no `package.json` → treat pre-built
  2. Vite/CRA/Next-export/Vue/Svelte: has `package.json` with a `build` script and one of `vite`, `react-scripts`, `@angular/cli`, `vue`, `svelte`, `next` in deps → run its build, then inject
  3. Plain `package.json` with `build` script → attempt build, treat `dist`/`build`/`out`/`www` as web root (first one found)
- `reject` — React Native (`ios/*.xcodeproj` + `Podfile` + no Capacitor), Flutter (`pubspec.yaml`), native-only, or nothing detectable

For `web-app` and `capacitor-partial`, the CI workflow does the injection (not the browser) — keeps zip small and lets `npm ci` resolve deps:

```bash
# Injection steps baked into workflows
npm ci || npm install
[ -f capacitor.config.* ] || npx -y @capacitor/cli@latest init "$APP_NAME" "$BUNDLE_ID" --web-dir="$WEB_DIR"
npm i -D @capacitor/cli
npm i @capacitor/core @capacitor/<android|ios>
[ -d <platform> ] || npx cap add <platform>
npm run build || true   # only if package.json has build script
npx cap sync <platform>
```

Store detection result + inferred `web_dir`, `app_name`, `bundle_id` on the `builds` row so the workflow reads them as inputs.

## Part 2 — iOS via Codemagic (shared account)

### Secrets (workspace-level, one-time)
- `CODEMAGIC_API_TOKEN` — shared Codemagic personal access token
- `CODEMAGIC_APP_ID` — the Codemagic app registered against the shared `apkforge-builds` GitHub repo
- `APP_STORE_CONNECT_ISSUER_ID`
- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_PRIVATE_KEY` — .p8 contents

I'll request these via `add_secret` once the code is in place.

### New files
- `src/lib/ios-workflow.ts` — `codemagic.yaml` template with an `ios-signed-release` workflow using `app-store-connect` integration and automatic code signing (bundle ID from build row)
- `src/lib/codemagic.server.ts` — thin REST client: `POST /builds` to trigger, `GET /builds/:id` to poll, `GET /builds/:id/artifacts/:artifactId` for the IPA
- Extend `src/lib/pipeline.functions.ts`:
  - `dispatchBuild` branches on `build.platform`: Android → GitHub Actions (today); iOS → push same source to same repo, then Codemagic `POST /builds` with `workflowId: ios-signed-release`, `branch: build/<id>`
  - `refreshBuildStatus` branches: iOS uses Codemagic status endpoints; on success pulls IPA and stores at `build-artifacts/<user>/<id>.ipa`

### DB
Migration to add `codemagic_build_id` (text, nullable) to `builds`. No new tables; Apple creds are workspace secrets, not per-user.

## Part 3 — UI

- `/new-build`: platform toggle (Android / iOS). Bundle ID field becomes required for iOS. Show a warning strip when detection returns `web-app` explaining "we'll add Capacitor for you in the cloud build."
- `/build/$id`: stage labels adapt per provider (Codemagic stages: "Provisioning → Building → Signing → Publishing")
- `/settings`: iOS section is workspace-managed — show "iOS signing configured by workspace admin" or "iOS signing not yet configured" based on whether the workspace secrets exist (via a small server fn that only returns booleans)

## Technical notes

- **Codemagic auth**: `x-auth-token: <CODEMAGIC_API_TOKEN>` header on all requests to `https://api.codemagic.io`
- **Signing**: Codemagic's `app-store-connect` integration + `automatic_code_signing: true` in `codemagic.yaml` provisions certs/profiles from the App Store Connect key at build time — no manual .p12/.mobileprovision handling
- **Failure surfacing**: Codemagic returns structured `buildActions[]` with logs URLs; store the last failing action's tail in `build_logs` just like GitHub Actions today
- **Rate limits**: Codemagic API is 100 req/min per token — 5s polling matches the Android side fine
- **Rejection UX**: `validate-zip.ts` returns `{ok:false, reason}` for RN/Flutter/native/empty; `/new-build` shows the reason instead of uploading

## Out of scope (still)

Push notifications, cert expiry preflight, TestFlight upload, per-user Codemagic accounts, iOS simulator/unsigned builds.

## Order of implementation

1. Zip detection + `web-app`/`capacitor-partial` classification
2. Android workflow updated to run injection when needed (proves the injection path on the cheap side first)
3. `codemagic.yaml` + Codemagic REST client + iOS branch in `dispatchBuild`/`refreshBuildStatus`
4. UI: platform toggle, detection warnings, settings visibility
5. Request workspace secrets, wire them up, smoke test one iOS build
