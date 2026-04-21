#!/usr/bin/env bash
#
# Chrome MCP Server — self-build installer
#
# Usage:
#   ./scripts/install.sh build                  Install deps + build shared/bridge/extension
#   ./scripts/install.sh register <EXT_ID>      Register native host for a given extension ID
#   ./scripts/install.sh all <EXT_ID>           build + register in one shot
#   ./scripts/install.sh unregister             Remove the native messaging manifest
#
# The <EXT_ID> is the 32-character Chrome extension ID you see on
# chrome://extensions after loading the unpacked folder.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_OUT="${ROOT}/app/chrome-extension/.output/chrome-mv3"
BRIDGE_DIST="${ROOT}/app/native-server/dist"
WASM_PKG="${ROOT}/packages/wasm-simd/pkg"
WASM_PREBUILT="${ROOT}/releases/chrome-extension/latest/chrome-mcp-server-extension/workers"

color() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
info() { color "34" "→ $1"; }
ok() { color "32" "✓ $1"; }
warn() { color "33" "⚠ $1"; }
err() { color "31" "✗ $1"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    exit 1
  fi
}

cmd_build() {
  require_cmd node
  require_cmd pnpm

  info "Installing workspace dependencies (pnpm)"
  pnpm config set enable-pre-post-scripts true >/dev/null 2>&1 || true
  # Ignore native-server postinstall failure: it runs before dist/ exists.
  (cd "$ROOT" && pnpm install) || warn "pnpm install reported errors (safe to ignore if only native-server postinstall failed)"

  info "Supplying prebuilt WASM (skips Rust toolchain)"
  mkdir -p "$WASM_PKG"
  if [ -f "${WASM_PREBUILT}/simd_math.js" ] && [ -f "${WASM_PREBUILT}/simd_math_bg.wasm" ]; then
    cp "${WASM_PREBUILT}/simd_math.js" "${WASM_PREBUILT}/simd_math_bg.wasm" "$WASM_PKG/"
    ok "Copied prebuilt WASM from release snapshot"
  else
    warn "No prebuilt WASM found; install Rust + wasm-pack and run 'pnpm build:wasm' manually"
  fi

  info "Building shared package"
  (cd "$ROOT" && pnpm build:shared)

  info "Building native-server (bridge)"
  (cd "$ROOT" && pnpm build:native)

  info "Copying WASM into extension workers"
  (cd "$ROOT" && pnpm copy:wasm) || true

  info "Building Chrome extension"
  (cd "$ROOT" && pnpm build:extension)

  ok "Build complete"
  echo
  echo "Extension folder: $EXT_OUT"
  echo "Bridge dist:      $BRIDGE_DIST"
  echo
  echo "Next:"
  echo "  1. chrome://extensions → enable Developer mode → Load unpacked → select:"
  echo "       $EXT_OUT"
  echo "  2. Copy the extension ID shown there"
  echo "  3. Run:"
  echo "       $0 register <EXT_ID>"
}

cmd_register() {
  local ext_id="${1:-}"
  if [ -z "$ext_id" ]; then
    err "Missing extension ID"
    echo "Usage: $0 register <EXT_ID>"
    exit 1
  fi
  if [ ! -f "${BRIDGE_DIST}/cli.js" ]; then
    err "Bridge not built yet. Run: $0 build"
    exit 1
  fi

  info "Registering native messaging host for extension ID: $ext_id"
  node "${BRIDGE_DIST}/cli.js" register --extension-id "$ext_id"

  ok "Registration complete"
  echo
  echo "Now:"
  echo "  1. Fully quit Chrome (Cmd+Q on macOS) and re-open it"
  echo "  2. Open the extension popup → click Connect"
  echo "  3. Add this to your MCP client config:"
  echo
  echo '      {'
  echo '        "mcpServers": {'
  echo '          "chrome-mcp": {'
  echo '            "type": "http",'
  echo '            "url": "http://127.0.0.1:12306/mcp"'
  echo '          }'
  echo '        }'
  echo '      }'
}

cmd_unregister() {
  info "Removing native messaging manifest"
  local manifest_paths=()
  case "$(uname -s)" in
    Darwin)
      manifest_paths+=("$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json")
      manifest_paths+=("$HOME/Library/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json")
      ;;
    Linux)
      manifest_paths+=("$HOME/.config/google-chrome/NativeMessagingHosts/com.chromemcp.nativehost.json")
      ;;
  esac
  for p in "${manifest_paths[@]}"; do
    if [ -f "$p" ]; then
      rm -f "$p"
      ok "Removed $p"
    fi
  done
  ok "Unregistered"
}

main() {
  local action="${1:-}"
  case "$action" in
    build) cmd_build ;;
    register) shift; cmd_register "${1:-}" ;;
    unregister) cmd_unregister ;;
    all) shift; cmd_build; cmd_register "${1:-}" ;;
    *)
      cat <<EOF
Chrome MCP Server — self-build installer

Usage:
  $0 build                Install deps + build everything
  $0 register <EXT_ID>    Register native host for the given extension ID
  $0 all <EXT_ID>         build + register
  $0 unregister           Remove the native messaging manifest

Typical flow:
  $0 build
  # Load app/chrome-extension/.output/chrome-mv3 in chrome://extensions
  # Copy the extension ID
  $0 register abc123...
EOF
      [ -z "$action" ] && exit 1 || exit 0
      ;;
  esac
}

main "$@"
