"""互通测试: rosz 发布, jazzy 容器内 rclpy 订阅端 (scripts/jazzy/listen.py) 接收.

由 scripts/jazzy/e2e.sh 运行; 另需环境变量 ROSZ_JAZZY_CONTAINER (容器名, e2e.sh 给出).
"""

import json
import os
import shlex
import subprocess
import time
from pathlib import Path

import numpy as np
import pytest

import rosz

CONTAINER = os.environ["ROSZ_JAZZY_CONTAINER"]
MESSAGES = Path(__file__).resolve().parents[2] / "messages"


@pytest.fixture(scope="module")
def rz():
    return rosz.connect()


def listen(topic, msg_type, *flags):
    """在容器里起 rclpy 订阅端, 等它建好订阅."""
    command = "source /env.sh; exec python3 /rosz/scripts/jazzy/listen.py " + shlex.join([topic, msg_type, *flags])
    listener = subprocess.Popen(["docker", "exec", CONTAINER, "bash", "-c", command], stdout=subprocess.PIPE, text=True)
    if listener.stdout.readline().strip() != "ready":
        raise RuntimeError("rclpy 订阅端未就绪")
    return listener


def received(listener, timeout=15):
    out = listener.communicate(timeout=timeout)[0]
    return [json.loads(line) for line in out.splitlines()]


def publish_until_received(publisher, message, listener, timeout=10):
    """volatile 话题: 订阅端匹配上之前发的会丢, 所以每 0.1 秒发一次直到订阅端收够退出."""
    deadline = time.monotonic() + timeout
    while listener.poll() is None and time.monotonic() < deadline:
        publisher.publish(message)
        time.sleep(0.1)
    return received(listener)


def test_rclpy_receives_published_dict_with_numpy_arrays(rz):
    publisher = rz.create_publisher("sensor_msgs/msg/JointState", "/rosz/joint_states")
    message = {
        "header": {"stamp": {"sec": 5, "nanosec": 6}, "frame_id": "base"},
        "name": ["a", "b"],
        "position": np.array([0.5, -1.0]),
        "velocity": [1, 2],
        "effort": np.array([], dtype=np.float32),
    }
    got = publish_until_received(publisher, message, listen("/rosz/joint_states", "sensor_msgs/msg/JointState"))
    assert got == [
        {
            "header": {"stamp": {"sec": 5, "nanosec": 6}, "frame_id": "base"},
            "name": ["a", "b"],
            "position": [0.5, -1.0],
            "velocity": [1.0, 2.0],
            "effort": [],
        }
    ]


def test_best_effort_publisher_of_type_from_msg_dirs():
    rz = rosz.connect(msg_dirs=[str(MESSAGES / "test")])
    qos = rosz.QoSProfile(depth=5, reliability="best_effort")
    publisher = rz.create_publisher("test_msgs/msg/BasicTypes", "/rosz/basic", qos)
    message = {
        "bool_value": True,
        "byte_value": 255,
        "char_value": 65,
        "float32_value": 1.5,
        "float64_value": -2.25,
        "int8_value": -128,
        "uint8_value": 255,
        "int16_value": -3,
        "uint16_value": 65535,
        "int32_value": -(2**31),
        "uint32_value": 2**32 - 1,
        "int64_value": -(2**63),
        "uint64_value": 2**64 - 1,
    }
    listener = listen("/rosz/basic", "test_msgs/msg/BasicTypes", "--best-effort")
    assert publish_until_received(publisher, message, listener) == [message]


def test_transient_local_late_subscriber_gets_history(rz):
    qos = rosz.QoSProfile(depth=2, durability="transient_local")
    publisher = rz.create_publisher("std_msgs/msg/String", "/rosz/latched", qos)
    for data in "abc":
        publisher.publish({"data": data})
    time.sleep(0.5)
    listener = listen("/rosz/latched", "std_msgs/msg/String", "--count", "2", "--depth", "2", "--transient-local")
    assert received(listener) == [{"data": "b"}, {"data": "c"}]


def test_bytes_on_wire_match_rclpy_and_carry_source_time(rz):
    # rclpy 发布的一条, 原值经 rosz 再发一遍, rosz 自己收回: 除 padding (rosz 写 0, fastcdr 不清零) 外逐字节相同
    original = rz.latest("/joint_states")
    publisher = rz.create_publisher("sensor_msgs/msg/JointState", "/rosz/joint_states_echo")
    time.sleep(0.5)
    with rz.subscribe(["/rosz/joint_states_echo"]) as subscription:
        echoed = None
        for _ in range(50):
            publisher.publish(original.value)
            echoed = subscription.recv(timeout=0.2)
            if echoed is not None:
                break
    same = len(echoed.payload) == len(original.payload) and all(
        a == b or a == 0 for a, b in zip(echoed.payload, original.payload)
    )
    assert (same, abs(echoed.receive_time_ns - echoed.source_time_ns) < 1_000_000_000) == (True, True)


def test_bad_values_and_unknown_types_are_rejected(rz):
    publisher = rz.create_publisher("std_msgs/msg/Header", "/rosz/header")
    with pytest.raises(rosz.EncodeError) as bad:
        publisher.publish({"stamp": {"sec": 1, "nanosec": -1}, "frame_id": "x"})
    with pytest.raises(LookupError) as unknown:
        rz.create_publisher("nope/msg/Nope", "/rosz/nope")
    assert (isinstance(bad.value, ValueError), bad.value.path, "nope/msg/Nope" in str(unknown.value)) == (
        True,
        "stamp.nanosec",
        True,
    )
