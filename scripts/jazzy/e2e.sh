#!/usr/bin/env bash
# 互通测试: 先 scripts/jazzy/setup.sh 与 scripts/jazzy/start.sh 起容器与发布端, 再跑本脚本.
# 在无 ROS 的干净 venv 里装 rosz wheel, 连容器内 rmw_zenohd (宿主网络, 端口取 ROSZ_JAZZY_PORT, 默认 7447).
set -euo pipefail
name=${1:-rosz-jazzy}; shift $(($# > 0))   # 余下参数交给 pytest
repo=$(cd "$(dirname "$0")/../.." && pwd)
work=${ROSZ_E2E_DIR:-/tmp/rosz-e2e}
rm -rf "$work" && mkdir -p "$work"
docker cp "$name:/tmp/rosz-e2e" "$work/ref"
cargo build --release -q -p rosz-cli --manifest-path "$repo/Cargo.toml"
wheel=$(ls "$repo"/dist/rosz-*-manylinux*_x86_64*.whl | head -1)
uv venv -q --python 3.12 "$work/venv"
VIRTUAL_ENV="$work/venv" uv pip install -q "$wheel" pytest pillow
export ROSZ_ROUTER=tcp/127.0.0.1:${ROSZ_JAZZY_PORT:-7447} ROSZ_BIN="$repo/target/release/rosz" ROSZ_E2E_REF="$work/ref"
cd "$work" && PATH="$work/venv/bin:$PATH" python -m pytest -q "$repo/tests/e2e" "$@"
