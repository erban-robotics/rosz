#!/usr/bin/env bash
# 起一次性 jazzy 容器 (rmw_zenoh_cpp 0.2.11, 与现场同版本), 供金样本生成与互通测试用. 不连机器人.
# 用法: [ROSZ_JAZZY_PORT=7447] scripts/jazzy/setup.sh [容器名]; 用完 `docker rm -f <容器名>`
# 宿主网络, router 端口取 ROSZ_JAZZY_PORT (默认 7447), 端口不同的容器可并行互不串扰.
# 容器内 `source /env.sh` 即 ROS 环境 + 节点连本容器 router.
set -euo pipefail
name=${1:-rosz-jazzy}
port=${ROSZ_JAZZY_PORT:-7447}
repo=$(cd "$(dirname "$0")/../.." && pwd)
# apt 源换成 2026-10-05 的 ROS 快照: 其中 rmw_zenoh_cpp 为 0.2.11 (现行源已是更高版本)
snapshot=http://snapshots.ros.org/jazzy/2026-10-05/ubuntu
docker run -d --rm --name "$name" --network host -v "$repo:/rosz:ro" ros:jazzy-ros-base sleep infinity >/dev/null
docker exec "$name" bash -euc "
rm -f /etc/apt/sources.list.d/ros2.sources
echo 'deb [trusted=yes] $snapshot noble main' > /etc/apt/sources.list.d/ros-snapshot.list
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --allow-downgrades \
  ros-jazzy-rmw-zenoh-cpp=0.2.11-1noble.20260915.171026 ros-jazzy-test-msgs ros-jazzy-common-interfaces \
  ros-jazzy-tf2-msgs ros-jazzy-audio-common-msgs ros-jazzy-rosidl-default-generators ros-jazzy-ament-cmake build-essential \
  python3-numpy python3-pil python3-zstandard >/dev/null
# erban 自定义类型: 用仓库内 .msg 现编一个包, 供金样本与发布用
mkdir -p /ws/src && cp -r /rosz/messages/erban/hand /ws/src/
cat > /ws/src/hand/package.xml <<'XML'
<?xml version=\"1.0\"?>
<package format=\"3\">
  <name>hand</name><version>0.0.0</version><description>erban</description>
  <maintainer email=\"dev@example.com\">rosz</maintainer><license>none</license>
  <buildtool_depend>ament_cmake</buildtool_depend>
  <buildtool_depend>rosidl_default_generators</buildtool_depend>
  <depend>std_msgs</depend>
  <member_of_group>rosidl_interface_packages</member_of_group>
  <export><build_type>ament_cmake</build_type></export>
</package>
XML
cat > /ws/src/hand/CMakeLists.txt <<'CMAKE'
cmake_minimum_required(VERSION 3.8)
project(hand)
find_package(ament_cmake REQUIRED)
find_package(rosidl_default_generators REQUIRED)
find_package(std_msgs REQUIRED)
rosidl_generate_interfaces(\${PROJECT_NAME} msg/PressureSensor.msg DEPENDENCIES std_msgs)
ament_package()
CMAKE
set +u; source /opt/ros/jazzy/setup.bash; set -u
cd /ws/src/hand && cmake -S . -B /ws/build -DCMAKE_INSTALL_PREFIX=/ws/install >/dev/null && cmake --build /ws/build -j8 >/dev/null && cmake --install /ws/build >/dev/null
cat > /env.sh <<ENV
source /opt/ros/jazzy/setup.bash
source /ws/install/share/hand/local_setup.bash
export RMW_IMPLEMENTATION=rmw_zenoh_cpp ROSZ_JAZZY_PORT=$port
export ZENOH_CONFIG_OVERRIDE='connect/endpoints=[\"tcp/localhost:$port\"]'
ENV
"
echo "容器 $name 就绪 (router 端口 $port); 进入环境: docker exec -it $name bash -c 'source /env.sh; bash'"
