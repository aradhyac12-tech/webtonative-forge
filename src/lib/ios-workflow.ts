export const IOS_WORKFLOW_PATH = "codemagic.yaml";
export const IOS_WORKFLOW_ID = "ios-signed-release";

// codemagic.yaml — reads env vars injected via Codemagic REST API dispatch.
// Signing uses App Store Connect API key (issuer id + key id + .p8) injected as
// APP_STORE_CONNECT_ISSUER_ID / APP_STORE_CONNECT_KEY_IDENTIFIER / APP_STORE_CONNECT_PRIVATE_KEY.
// LOGO_URL is optional — when set, we download it and generate iOS icons via @capacitor/assets.
export const IOS_WORKFLOW_YAML = `workflows:
  ios-signed-release:
    name: APKForge iOS
    max_build_duration: 60
    instance_type: mac_mini_m1
    environment:
      xcode: latest
      cocoapods: default
      node: 22
    scripts:
      - name: Fetch source
        script: |
          set -e
          curl -sSL --fail -o source.zip "$SOURCE_URL"
          mkdir project
          unzip -q source.zip -d project
      - name: Install & inject Capacitor (iOS)
        script: |
          set -e
          cd project
          if [ ! -f package.json ]; then
            echo '{"name":"apkforge-app","version":"1.0.0","private":true}' > package.json
          fi
          npm install --no-audit --no-fund || npm install --no-audit --no-fund --legacy-peer-deps
          if [ ! -f capacitor.config.ts ] && [ ! -f capacitor.config.js ] && [ ! -f capacitor.config.json ]; then
            npm i @capacitor/core @capacitor/cli
            mkdir -p "$WEB_DIR"
            [ -f "$WEB_DIR/index.html" ] || echo "<!doctype html><html><body><h1>$APP_NAME</h1></body></html>" > "$WEB_DIR/index.html"
            npx cap init "$APP_NAME" "$BUNDLE_ID" --web-dir="$WEB_DIR"
          fi
          npm i @capacitor/ios || true
          if node -e "process.exit((require('./package.json').scripts||{}).build?0:1)" 2>/dev/null; then
            npm run build || echo "build script failed — continuing"
          fi
          if [ ! -d ios ]; then
            npx cap add ios
          fi
          npx cap sync ios || true
      - name: Resolve app icon
        script: |
          set -e
          cd project
          mkdir -p resources
          if [ -n "$LOGO_URL" ]; then
            echo "Using uploaded logo"
            curl -sSL --fail -o resources/icon.png "$LOGO_URL"
          elif [ ! -f resources/icon.png ]; then
            for candidate in public/icon.png public/logo.png public/apple-touch-icon.png src/assets/icon.png src/assets/logo.png assets/icon.png assets/logo.png icon.png logo.png; do
              if [ -f "$candidate" ]; then
                echo "Auto-detected icon at $candidate"
                cp "$candidate" resources/icon.png
                break
              fi
            done
          fi
          if [ -f resources/icon.png ]; then
            npm i -D @capacitor/assets || true
            npx @capacitor/assets generate --ios --iconBackgroundColor '#ffffff' --iconBackgroundColorDark '#000000' || echo "asset generation failed — continuing with default icon"
          else
            echo "No icon supplied or detected — using Capacitor default"
          fi
      - name: CocoaPods install
        script: |
          set -e
          cd project/ios/App
          pod install
      - name: Fetch signing files
        script: |
          set -e
          keychain initialize
          app-store-connect fetch-signing-files "$BUNDLE_ID" \\
            --type IOS_APP_ADHOC \\
            --create
          keychain add-certificates
          xcode-project use-profiles
      - name: Build IPA
        script: |
          set -e
          cd project/ios/App
          xcode-project build-ipa \\
            --workspace App.xcworkspace \\
            --scheme App
    artifacts:
      - project/ios/App/build/ios/ipa/*.ipa
      - /tmp/xcodebuild_logs/*.log
`;
