
## What the upload actually is

`apk-ipa-pal-main.zip` is already a complete Lovable TanStack Start builder app. It ships:

- Auth-gated routes: `dashboard`, `new-build`, `build/$id`, `settings`
- Server logic: `pipeline.functions.ts`, `github.server.ts`, `codemagic.server.ts`, `android-workflow.ts`, `ios-workflow.ts`, `validate-zip.ts`
- Supabase migrations (3 files) for builds/users/etc.
- Lovable Cloud auth integration (`@lovable.dev/cloud-auth-js`)

So the "build the universal builder" work is largely already done in the upload — I just need to land it in this project and make it run.

## Plan

### 1. Replace scaffold with uploaded project
- Delete the current placeholder `src/` and root config (`package.json`, `vite.config.ts`, `tsconfig.json`, `components.json`, `bunfig.toml`, `eslint.config.js`, `bun.lock`).
- Copy `apk-ipa-pal-main/*` into project root (excluding any `.git`, `node_modules`, `AGENTS.md` conflicts — keep current `AGENTS.md`).
- Copy `public/` assets.

### 2. Install dependencies
- Run `bun install` so the new `package.json` (with jszip, supabase-js, tweetnacl, etc.) resolves.

### 3. Enable Lovable Cloud + apply migrations
- Call `supabase--enable`.
- Apply the 3 migrations from `supabase/migrations/` to create the builds/users schema.

### 4. Configure secrets for CI dispatch
Ask user (after plan) to supply, via `add_secret`:
- `GITHUB_TOKEN` — PAT with `repo` + `workflow` scope (Android AAB/APK via GitHub Actions ubuntu-latest, iOS IPA via macos-latest).
- `GITHUB_OWNER`, `GITHUB_REPO` — target repo for workflow dispatches.
- `CODEMAGIC_API_TOKEN` — for iOS signing / Apple Developer flows.
- Optional: `APPLE_TEAM_ID`, `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `IOS_P12_BASE64`, `IOS_P12_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64` — passed through to build workflows.

Skip any that are already present; don't block on optional signing secrets (unsigned debug APK path stays available).

### 5. Verify the preview works
- Confirm `bun install` succeeded, dev server boots, `/auth` and `/dashboard` render, and a smoke `new-build` upload validates a zip via `validate-zip.ts` without touching real CI.
- Fix any import / typecheck breakage introduced by version drift between the upload's `package.json` and the current template.

### 6. What I will NOT change
- Won't rewrite `pipeline.functions.ts`, `github.server.ts`, `codemagic.server.ts`, or the workflow YAML generators — the upload already implements the "detect Capacitor / generate native config / dispatch build / poll artifacts" pipeline. If something is broken after boot, fix in place.
- Won't add Xcode/Android SDK to this sandbox — real compilation runs on the external CI runners (GitHub Actions macOS/ubuntu + Codemagic), which is the only way to produce real APK/AAB/IPA. This project is the dispatcher + dashboard.

## Technical notes

- The upload uses `@lovable.dev/vite-tanstack-config` 2.7.1 and `vite ^8` — same family as the current template, so should slot in cleanly. If lockfile conflicts, delete `bun.lock` and reinstall.
- `nitro` is a devDependency; safe on the Cloudflare Worker runtime because it isn't imported at runtime.
- Capacitor CLI is not installed here; native project generation happens inside the CI workflows the app dispatches, not in this sandbox. That matches the "no Android Studio / Xcode required by end user" requirement — the runners do it.
- If a required capability truly needs local native compilation (e.g. producing an IPA without any macOS runner), that's not possible from a web sandbox and I'll surface it as a hard error in the build status UI rather than pretend it worked.
