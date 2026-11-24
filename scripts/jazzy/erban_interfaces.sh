#!/usr/bin/env bash
# 在 jazzy 容器里现编测试用的 erban_interfaces 包 (messages/test/erban_interfaces: Receipt.msg + GetPreset.srv, 取自 erban-caring 的 IDL 草案),
# 装到容器 /ws/erban. 只有服务互通测试用, 不放进 setup.sh 免得拖慢别的测试; 已编过则跳过.
# 用法: scripts/jazzy/erban_interfaces.sh [容器名]; 之后容器内 `source /ws/erban/share/erban_interfaces/local_setup.bash`
set -euo pipefail
name=${1:-rosz-jazzy}
docker exec "$name" bash -euc '
test -f /ws/erban/share/erban_interfaces/local_setup.bash && exit 0
rm -rf /ws/src/erban_interfaces && cp -r /rosz/messages/test/erban_interfaces /ws/src/
cat > /ws/src/erban_interfaces/package.xml <<XML
<?xml version="1.0"?>
<package format="3">
  <name>erban_interfaces</name><version>0.0.0</version><description>erban</description>
  <maintainer email="dev@example.com">rosz</maintainer><license>none</license>
  <buildtool_depend>ament_cmake</buildtool_depend>
  <buildtool_depend>rosidl_default_generators</buildtool_depend>
  <member_of_group>rosidl_interface_packages</member_of_group>
  <export><build_type>ament_cmake</build_type></export>
</package>
XML
cat > /ws/src/erban_interfaces/CMakeLists.txt <<CMAKE
cmake_minimum_required(VERSION 3.8)
project(erban_interfaces)
find_package(ament_cmake REQUIRED)
find_package(rosidl_default_generators REQUIRED)
rosidl_generate_interfaces(\${PROJECT_NAME} msg/Receipt.msg srv/GetPreset.srv)
ament_package()
CMAKE
set +u; source /opt/ros/jazzy/setup.bash; set -u
cd /ws/src/erban_interfaces
cmake -S . -B /ws/build_erban -DCMAKE_INSTALL_PREFIX=/ws/erban >/dev/null
cmake --build /ws/build_erban -j8 >/dev/null && cmake --install /ws/build_erban >/dev/null
'
