#!/usr/bin/env bash
# setup-check.sh — fail-loud preflight for the video-pipeline-gui dev environment.
#
# Embodies the repo's own tenet 5 (deny-by-default at the boundary): a missing
# toolchain, an absent Tauri scaffold asset, or an unimportable test dependency
# fails here, with a fix, instead of surfacing later as a Rust panic or an
# ImportError. Run before first launch:  bash scripts/setup-check.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; printf '       -> %s\n' "$2"; fail=1; }

echo "video-pipeline-gui setup-check"
echo "------------------------------"

# 1) Rust toolchain
for b in rustc cargo; do
  if command -v "$b" >/dev/null 2>&1; then ok "$b ($($b --version 2>/dev/null | head -1))"
  else bad "$b not on PATH" "install rustup; ensure ~/.cargo/env is sourced in your shell rc"; fi
done

# 2) Node
if command -v node >/dev/null 2>&1; then ok "node ($(node --version))"
else bad "node not on PATH" "install Node 18+"; fi

# 3) Tauri CLI reachable (local devDependency preferred over global)
if npx --no-install tauri --version >/dev/null 2>&1; then ok "tauri CLI ($(npx --no-install tauri --version 2>/dev/null))"
else bad "tauri CLI not resolvable" "npm install (adds @tauri-apps/cli devDependency), then 'npm run tauri'"; fi

# 4) Required Tauri scaffold assets — the icons referenced by tauri.conf.json
for ico in src-tauri/icons/icon.icns src-tauri/icons/icon.png; do
  if [ -f "$ico" ]; then ok "$ico present"
  else bad "$ico missing" "generate the set: npm run tauri icon assets/icon-source.png"; fi
done

# 5) Python test deps import cleanly in the chosen interpreter
PYBIN="${PYBIN:-./.venv/bin/python}"
[ -x "$PYBIN" ] || PYBIN="$(command -v python3 || true)"
if [ -n "$PYBIN" ]; then
  if "$PYBIN" -c "import jsonschema" >/dev/null 2>&1; then ok "jsonschema importable ($PYBIN)"
  else bad "jsonschema not importable in $PYBIN" "python3 -m venv .venv && ./.venv/bin/pip install -r requirements-test.txt"; fi
  # arch sanity on Apple Silicon: catch x86_64 wheels under arm64 runtime
  if [ "$(uname -m)" = "arm64" ]; then
    "$PYBIN" - <<'PY' >/dev/null 2>&1 || bad "jsonschema stack failed to load (likely mixed-arch wheel)" "rebuild deps in a fresh arm64 .venv; avoid global site-packages"
import jsonschema, importlib
importlib.import_module("referencing")  # pulls rpds native ext — the arch tripwire
PY
  fi
else
  bad "no python3 found" "install Python 3.11+"
fi

echo "------------------------------"
[ "$fail" = 0 ] && { echo "all checks passed"; exit 0; } || { echo "one or more checks failed — see fixes above"; exit 1; }
