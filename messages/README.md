# messages

- `jazzy/`: 编译期内置的 ROS 2 jazzy 消息与服务定义, 复制自 `ros:jazzy-ros-base` 镜像 `/opt/ros/jazzy/share/*/msg` 与 `*/srv` (`.srv` 只取此处已有的包, 另加 std_srvs 5.3.8) (common_interfaces 5.3.8, rcl_interfaces 2.0.4, geometry2 0.36.23 等, 版本见各包 `package.xml`). 许可证同上游 (各包 `package.xml` 的 `<license>`, 多为 Apache-2.0)
- `erban/`: 编译期内置的 erban 自定义消息 (`hand/msg/PressureSensor` 来自 erban-caring `orin/robot_state/messages`)
- `test/`: test_msgs 2.0.4 (`.msg` 与 `.srv`), 不内置, 只在金样本测试里运行时追加
- `golden/`: 解码金样本. 由 `scripts/jazzy/golden.sh` 在一次性 jazzy 容器 (rmw_zenoh_cpp 0.2.11) 里生成: `<rmw>/<样例>.cdr` 为 rclpy `serialize_message` 输出 (rmw_zenoh_cpp 与 rmw_fastrtps_cpp 各一份, 两者 padding 内容不同), `expected.json` 为 rclpy 参照值, `hashes.json` 为 rosidl 生成的 RIHS01 (`.srv` 含顶层与 `_Request/_Response/_Event` 四个)

更新内置定义: 换 `jazzy/` 下文件后重新生成金样本, `cargo test -p rosz-decode` 通过即可.
