#!/usr/bin/env bash
#
# Build the acadrust WASM bridge for the browser / Cloudflare Workers.
#
#   ./scripts/build-wasm.sh            # release build (what you deploy)
#   ./scripts/build-wasm.sh --debug    # faster, much larger artifact
#
# Two steps, both pinned:
#   1. cargo build --target wasm32-unknown-unknown
#   2. wasm-bindgen --target web   (must match the wasm-bindgen crate version)
#
# Requires:
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version 0.2.129 --locked
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="$ROOT_DIR/crates/acadrust-wasm"
OUT_DIR="$ROOT_DIR/packages/cad-acadrust/wasm"

# Keep in sync with `wasm-bindgen` in crates/acadrust-wasm/Cargo.toml.
WASM_BINDGEN_VERSION="0.2.129"

PROFILE="release"
CARGO_PROFILE_FLAG="--release"
if [[ "${1:-}" == "--debug" ]]; then
  PROFILE="debug"
  CARGO_PROFILE_FLAG=""
fi

if ! command -v cargo >/dev/null 2>&1; then
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  else
    echo "error: cargo not found. Install Rust: https://rustup.rs" >&2
    exit 1
  fi
fi

if ! rustup target list --installed 2>/dev/null | grep -q '^wasm32-unknown-unknown$'; then
  echo "==> adding wasm32-unknown-unknown target"
  rustup target add wasm32-unknown-unknown
fi

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "error: wasm-bindgen CLI not found." >&2
  echo "       cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked" >&2
  exit 1
fi

INSTALLED_VERSION="$(wasm-bindgen --version | awk '{print $2}')"
if [[ "$INSTALLED_VERSION" != "$WASM_BINDGEN_VERSION" ]]; then
  echo "error: wasm-bindgen CLI is $INSTALLED_VERSION but the crate pins $WASM_BINDGEN_VERSION." >&2
  echo "       A mismatch fails at runtime with a schema-version error." >&2
  echo "       cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked --force" >&2
  exit 1
fi

echo "==> cargo build ($PROFILE)"
cd "$CRATE_DIR"
cargo build $CARGO_PROFILE_FLAG --target wasm32-unknown-unknown

WASM_SRC="$CRATE_DIR/target/wasm32-unknown-unknown/$PROFILE/acadrust_wasm.wasm"
if [[ ! -f "$WASM_SRC" ]]; then
  echo "error: expected artifact not found at $WASM_SRC" >&2
  exit 1
fi

echo "==> wasm-bindgen --target web"
# `--target web` emits ESM glue (the .js) plus the .wasm as a sibling asset.
# The app serves both from /wasm/ and dynamic-imports the glue, so no
# bundler-specific .wasm loader is required — and the same pair works inside a
# Web Worker.
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
wasm-bindgen --target web --out-dir "$OUT_DIR" --out-name acadrust_wasm "$WASM_SRC"

echo "==> wrote:"
ls -la "$OUT_DIR"
