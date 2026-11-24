"""采集互通测试的额外发布端 (jazzy 容器内, 由 tests/e2e 经 docker exec 拉起): 每次运行是一个独立的发布进程.

用法:
    python3 publish_collect.py late <首个 stamp 秒> <条数>
        /collect/late JointState, volatile. 等到有订阅端才开始, 以 100 Hz 发 <条数> 条后退出;
        第 i 条 (0 起) header.stamp = <首个 stamp 秒> + i 毫秒. 连跑两次即 "发布进程重启".
    python3 publish_collect.py latched <秒>
        /collect/latched String, transient_local keep_last(5): 一启动就发 "latched0".."latched2" 三条, 再存活 <秒> 后退出.
"""

import sys
import time

import rclpy
from builtin_interfaces.msg import Time
from rclpy.qos import DurabilityPolicy, QoSProfile
from sensor_msgs.msg import JointState
from std_msgs.msg import Header, String

LATE_TOPIC = "/collect/late"
LATCHED_TOPIC = "/collect/latched"
SUBSCRIBER_WAIT_SEC = 20.0
# 发完到退出之间留给订阅端接收的时间
LINGER_SEC = 1.0


def spin_for(node, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        rclpy.spin_once(node, timeout_sec=0.01)


def late(node, first_sec, count):
    publisher = node.create_publisher(JointState, LATE_TOPIC, 10)
    deadline = time.monotonic() + SUBSCRIBER_WAIT_SEC
    while publisher.get_subscription_count() == 0:
        if time.monotonic() > deadline:
            sys.exit(f"{SUBSCRIBER_WAIT_SEC} 秒内没有订阅端")
        spin_for(node, 0.05)
    for i in range(count):
        stamp_ns = first_sec * 10**9 + i * 10**6
        header = Header(stamp=Time(sec=stamp_ns // 10**9, nanosec=stamp_ns % 10**9), frame_id="late")
        publisher.publish(JointState(header=header, name=["j"], position=[float(i)]))
        spin_for(node, 0.01)
    spin_for(node, LINGER_SEC)


def latched(node, seconds):
    qos = QoSProfile(depth=5, durability=DurabilityPolicy.TRANSIENT_LOCAL)
    publisher = node.create_publisher(String, LATCHED_TOPIC, qos)
    for i in range(3):
        publisher.publish(String(data=f"latched{i}"))
    spin_for(node, seconds)


def main():
    rclpy.init()
    node = rclpy.create_node("rosz_collect_publisher")
    mode, *args = sys.argv[1:]
    if mode == "late":
        late(node, int(args[0]), int(args[1]))
    else:
        latched(node, float(args[0]))
    node.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    main()
