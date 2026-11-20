#!/usr/bin/env bash
# 在容器里起 rmw_zenohd (tcp/0.0.0.0:7447, 宿主网络) 与测试发布端; 参照值写到容器 /tmp/rosz-e2e
set -euo pipefail
name=${1:-rosz-jazzy}
env='source /opt/ros/jazzy/setup.bash; source /ws/install/share/hand/local_setup.bash; export RMW_IMPLEMENTATION=rmw_zenoh_cpp'
docker exec -d "$name" bash -c "$env; exec ros2 run rmw_zenoh_cpp rmw_zenohd > /tmp/zenohd.log 2>&1"
sleep 2
docker exec -d "$name" bash -c "$env; exec python3 /rosz/scripts/jazzy/publish.py /tmp/rosz-e2e > /tmp/publish.log 2>&1"
for _ in $(seq 30); do
  docker exec "$name" test -f /tmp/rosz-e2e/color.jpg && exit 0
  sleep 1
done
echo "发布端未就绪:" >&2; docker exec "$name" cat /tmp/publish.log >&2; exit 1
