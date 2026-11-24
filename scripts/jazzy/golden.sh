#!/usr/bin/env bash
# 重新生成 messages/golden (需先 scripts/jazzy/setup.sh 起容器)
set -euo pipefail
name=${1:-rosz-jazzy}
repo=$(cd "$(dirname "$0")/../.." && pwd)
docker exec "$name" bash -c '
set -e; source /env.sh
rm -rf /tmp/golden
for rmw in rmw_zenoh_cpp rmw_fastrtps_cpp; do RMW_IMPLEMENTATION=$rmw python3 /rosz/scripts/jazzy/golden.py /tmp/golden; done'
rm -rf "$repo/messages/golden"
docker cp "$name:/tmp/golden" "$repo/messages/golden"
