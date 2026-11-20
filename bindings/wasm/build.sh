#!/usr/bin/env bash
# 构建 WASM 包并 npm pack 到仓库 dist/. 需 wasm32-unknown-unknown 目标与同版本 wasm-bindgen-cli (见 Cargo.toml).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
cargo build -q -p rosz-wasm --target wasm32-unknown-unknown --profile wasm --manifest-path "$repo/Cargo.toml"
rm -rf "$here/pkg" && mkdir -p "$here/pkg" "$repo/dist"
wasm-bindgen --target web --remove-name-section --remove-producers-section --out-dir "$here/pkg" \
  "$repo/target/wasm32-unknown-unknown/wasm/rosz_wasm.wasm"
if command -v wasm-opt >/dev/null; then
  wasm-opt -Oz --all-features "$here/pkg/rosz_wasm_bg.wasm" -o "$here/pkg/rosz_wasm_bg.wasm"
fi
# 版本号取 workspace
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$repo/Cargo.toml" | head -1)
sed "s/\"version\": \".*\"/\"version\": \"$version\"/" "$here/package.json" > "$here/pkg/package.json"
cp "$here/README.md" "$here/pkg/"
(cd "$here/pkg" && npm pack -q --pack-destination "$repo/dist")
