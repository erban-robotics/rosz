#!/usr/bin/env bash
# 在容器里起 rmw_zenohd (宿主网络, 端口为 setup.sh 时的 ROSZ_JAZZY_PORT) 与测试发布端; 参照值写到容器 /tmp/rosz-e2e
set -euo pipefail
name=${1:-rosz-jazzy}
# router 只听本容器端口, 关多播, 免得并行的几个容器互相连上
router='export ZENOH_CONFIG_OVERRIDE="listen/endpoints=[\"tcp/[::]:$ROSZ_JAZZY_PORT\"];scouting/multicast/enabled=false"'
docker exec -d "$name" bash -c "source /env.sh; $router; exec ros2 run rmw_zenoh_cpp rmw_zenohd > /tmp/zenohd.log 2>&1"
sleep 2
docker exec -d "$name" bash -c "source /env.sh; exec python3 /rosz/scripts/jazzy/publish.py /tmp/rosz-e2e > /tmp/publish.log 2>&1"
for _ in $(seq 30); do
  docker exec "$name" test -f /tmp/rosz-e2e/color.jpg && exit 0
  sleep 1
done
echo "发布端未就绪:" >&2; docker exec "$name" cat /tmp/publish.log >&2; exit 1
