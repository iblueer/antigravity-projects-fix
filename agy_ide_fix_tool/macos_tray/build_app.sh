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
