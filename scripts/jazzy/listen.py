"""互通测试的 rclpy 订阅端 (jazzy 容器内): 订阅一个话题, 每收到一条打印一行 JSON (rclpy 值), 收够或超时退出.

用法: python3 listen.py <话题> <包/msg/类型> [--count N] [--timeout 秒] [--depth N] [--best-effort] [--transient-local]
先打印一行 "ready" (订阅已建), 超时未收够时退出码为 1.
"""

import argparse
import array
import importlib
import json
import sys
import time

import numpy as np
import rclpy
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy


def plain(value):
    """rclpy 值转 JSON: byte 为 int, 数组为列表 (同 golden.py)."""
    if hasattr(value, "get_fields_and_field_types"):
        return {field: plain(getattr(value, field)) for field in value.get_fields_and_field_types()}
    if isinstance(value, bytes) and len(value) == 1:
        return value[0]
    if isinstance(value, (bytes, bytearray, array.array)):
        return list(value)
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if isinstance(value, np.generic):
        return value.item()
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("topic")
    parser.add_argument("type")
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--depth", type=int, default=10)
    parser.add_argument("--best-effort", action="store_true")
    parser.add_argument("--transient-local", action="store_true")
    args = parser.parse_args()

    package, _, name = args.type.split("/")
    msg_type = getattr(importlib.import_module(f"{package}.msg"), name)
    qos = QoSProfile(
        depth=args.depth,
        reliability=ReliabilityPolicy.BEST_EFFORT if args.best_effort else ReliabilityPolicy.RELIABLE,
        durability=DurabilityPolicy.TRANSIENT_LOCAL if args.transient_local else DurabilityPolicy.VOLATILE,
    )
    rclpy.init()
    node = rclpy.create_node("rosz_listen")
    received = []
    node.create_subscription(msg_type, args.topic, lambda m: received.append(plain(m)), qos)
    print("ready", flush=True)
    deadline = time.monotonic() + args.timeout
    printed = 0
    while printed < args.count and time.monotonic() < deadline:
        rclpy.spin_once(node, timeout_sec=0.05)
        for value in received[printed:args.count]:
            print(json.dumps(value), flush=True)
        printed = min(len(received), args.count)
    node.destroy_node()
    rclpy.shutdown()
    sys.exit(0 if printed >= args.count else 1)


if __name__ == "__main__":
    main()
