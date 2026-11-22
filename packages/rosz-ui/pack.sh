#!/usr/bin/env bash
# 构建 rosz-ui 并 npm pack 到仓库 dist/. 需先在仓库根 npm install (WASM 包须已由 bindings/wasm/build.sh 生成).
# workspace 里 rosz-wasm 依赖写 "*" 指本地包; 发版包里改成同版本 Release 上的 tgz 地址, 版本号取 workspace.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$repo/Cargo.toml" | head -1)
rm -rf "$here/dist"   # 库构建不清空 dist (emptyOutDir: false), 先删掉旧产物再打包
(cd "$here" && npm run build)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -r "$here/dist" "$here/README.md" "$stage/"
VERSION=$version node -e '
const fs = require("fs")
const p = JSON.parse(fs.readFileSync(process.argv[1]))
const v = process.env.VERSION
p.version = v
p.dependencies["@erban-robotics/rosz-wasm"] =
  `https://github.com/erban-robotics/rosz/releases/download/v${v}/erban-robotics-rosz-wasm-${v}.tgz`
delete p.devDependencies
delete p.scripts
fs.writeFileSync(process.argv[2], JSON.stringify(p, null, 2) + "\n")
' "$here/package.json" "$stage/package.json"
mkdir -p "$repo/dist"
(cd "$stage" && npm pack -q --pack-destination "$repo/dist")
