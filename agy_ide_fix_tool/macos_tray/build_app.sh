#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-/tmp/agy-session-tray-build}"
CACHE_DIR="${CACHE_DIR:-/tmp/agy-session-tray-cache}"
APP_DIR="$SCRIPT_DIR/dist/AgySessionTray.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
ICON_SOURCE="$SCRIPT_DIR/Resources/AppIcon.png"
ICONSET_DIR="$BUILD_DIR/AppIcon.iconset"
ICON_FILE="$RESOURCES_DIR/AppIcon.icns"

cd "$SCRIPT_DIR"
mkdir -p "$CACHE_DIR/clang" "$CACHE_DIR/swiftpm"
export CLANG_MODULE_CACHE_PATH="$CACHE_DIR/clang"
export SWIFTPM_CACHE_PATH="$CACHE_DIR/swiftpm"
swift build \
  --configuration release \
  --scratch-path "$BUILD_DIR" \
  -Xcc -fmodules-cache-path="$CACHE_DIR/clang"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
cp "$BUILD_DIR/release/AgySessionTray" "$MACOS_DIR/AgySessionTray"
chmod +x "$MACOS_DIR/AgySessionTray"

if [[ -f "$ICON_SOURCE" ]]; then
  rm -rf "$ICONSET_DIR"
  mkdir -p "$ICONSET_DIR"
  sips -z 16 16 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
  sips -z 32 32 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
  sips -z 32 32 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
  sips -z 64 64 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
  sips -z 128 128 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
  sips -z 256 256 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
  sips -z 256 256 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
  sips -z 512 512 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
  sips -z 512 512 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
  sips -z 1024 1024 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_512x512@2x.png" >/dev/null
  iconutil -c icns "$ICONSET_DIR" -o "$ICON_FILE"
fi

cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>AgySessionTray</string>
  <key>CFBundleIdentifier</key>
  <string>com.maemolee.AgySessionTray</string>
  <key>CFBundleName</key>
  <string>AgySessionTray</string>
  <key>CFBundleDisplayName</key>
  <string>Antigravity Sessions</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <false/>
  <key>NSHumanReadableCopyright</key>
  <string>Local utility</string>
  <key>LSEnvironment</key>
  <dict>
    <key>AGY_FIX_TOOL_ROOT</key>
    <string>$TOOL_ROOT</string>
  </dict>
</dict>
</plist>
PLIST

echo "$APP_DIR"
