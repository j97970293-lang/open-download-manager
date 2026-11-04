#!/usr/bin/env bash
# One-liner install: puts `odm` on your PATH and optionally starts the dashboard.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$HOME/.local}"

if ! command -v node >/dev/null; then
  echo "Node.js 20.11+ is required. Install it first: https://nodejs.org" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js $(node -v) is too old; 20.11+ is required." >&2
  exit 1
fi

mkdir -p "$PREFIX/bin"
ln -sf "$ROOT/apps/cli/bin/odm.js" "$PREFIX/bin/odm"
chmod +x "$ROOT/apps/cli/bin/odm.js"

echo "installed: $PREFIX/bin/odm -> $ROOT/apps/cli/bin/odm.js"
case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) echo "add this to your shell profile: export PATH=\"$PREFIX/bin:\$PATH\"" ;;
esac

echo
echo "try:"
echo "  odm add https://example.com/file.iso -c 16"
echo "  odm serve --port 8420     # dashboard at http://localhost:8420"
echo "  odm mcp                   # expose the engine to your coding agent"
