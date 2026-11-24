"""采集互通测试: jazzy 容器 (rmw_zenoh_cpp 0.2.11) 发布, 本机 rosz 采集写 MCAP, 读回核对条数与字段.

由 scripts/jazzy/e2e.sh 运行; 除 test_e2e.py 的环境变量外还需 ROSZ_JAZZY_CONTAINER (容器名, 用来拉起额外发布端).
常驻发布端见 scripts/jazzy/publish.py, 晚上线 / transient_local / 重启的发布端见 scripts/jazzy/publish_collect.py.
schema 对照 message_schema.json 由 gen_message_schema.py 从 erban-caring 录制器的 `episode_data.message_schema` 生成.
"""

import json
import os
import signal
import struct
import subprocess
import time
from pathlib import Path

import pytest
from mcap.reader import make_reader

import rosz

CONTAINER = os.environ["ROSZ_JAZZY_CONTAINER"]
LATE, LATCHED = "/collect/late", "/collect/latched"
TOPICS = ["/joint_states", "/tf_static", "/hand/pressure", LATCHED, LATE]
# 晚上线话题两次发布进程各发 50 条, header.stamp 从这里起每条加 1 毫秒; 第二次再晚 1 秒
LATE_FIRST_SEC = 1763700000
LATE_COUNT = 50
SCHEMAS = json.loads(Path(__file__).with_name("message_schema.json").read_text())


def container_publish(*args, detach=False):
    command = "source /env.sh; exec python3 /rosz/scripts/jazzy/publish_collect.py " + " ".join(map(str, args))
    subprocess.run(["docker", "exec", *(["-d"] if detach else []), CONTAINER, "bash", "-c", command], check=True, timeout=60)


def read_mcap(path):
    """Returns: (header, summary, {话题: [(schema, channel, message)]})"""
    with open(path, "rb") as stream:
        reader = make_reader(stream)
        by_topic = {}
        for schema, channel, message in reader.iter_messages(log_time_order=False):
            by_topic.setdefault(channel.topic, []).append((schema, channel, message))
        return reader.get_header(), reader.get_summary(), by_topic


def header_stamp_ns(data):
    sec, nanosec = struct.unpack_from("<iI", data, 4)
    return sec * 10**9 + nanosec


def cdr_string(data):
    (length,) = struct.unpack_from("<I", data, 4)
    return data[8 : 8 + length - 1].decode()


def late_stamps():
    return [(LATE_FIRST_SEC + run) * 10**9 + i * 10**6 for run in range(2) for i in range(LATE_COUNT)]


@pytest.fixture(scope="module")
def recording(tmp_path_factory):
    rz = rosz.connect()
    # transient_local 发布端先发完 3 条历史, 采集后开
    container_publish("latched", 30, detach=True)
    deadline = time.monotonic() + 10
    while LATCHED not in [t.name for t in rz.topics()] and time.monotonic() < deadline:
        time.sleep(0.1)
    path = tmp_path_factory.mktemp("collect") / "recording.mcap"
    collector = rz.collect(str(path), TOPICS, compression="zstd", chunk_size=64 * 1024)
    # 晚上线话题: 开录后才有发布端, 发完退出再起一个 (发布进程重启)
    container_publish("late", LATE_FIRST_SEC, LATE_COUNT)
    container_publish("late", LATE_FIRST_SEC + 1, LATE_COUNT)
    running = collector.stats()
    final = collector.stop()
    header, summary, messages = read_mcap(path)
    return {"running": running, "final": final, "header": header, "summary": summary, "messages": messages}


def test_collect_subscribes_late_topic_across_publisher_restart(recording):
    stamps = [header_stamp_ns(m.data) for _, _, m in recording["messages"][LATE]]
    assert stamps == late_stamps()


def test_collect_takes_transient_local_history(recording):
    assert [cdr_string(m.data) for _, _, m in recording["messages"][LATCHED]] == ["latched0", "latched1", "latched2"]


def test_collect_writes_ros2_profile_fields(recording):
    messages = recording["messages"]
    # transient_local 历史的 publish_time 是当初发出时刻, 不看
    every = [m for topic in ["/joint_states", "/hand/pressure", LATE] for _, _, m in messages[topic]]
    channels = {c.topic: (c.message_encoding, s.encoding, s.name) for items in messages.values() for s, c, _ in items}
    compressions = {chunk.compression for chunk in recording["summary"].chunk_indexes}
    assert (
        recording["header"].profile,
        all(m.publish_time <= m.log_time < m.publish_time + 10**9 for m in every),
        [m.sequence for _, _, m in messages[LATE]],
        channels["/joint_states"],
        compressions,
    ) == ("ros2", True, list(range(1, LATE_COUNT + 1)) * 2, ("cdr", "ros2msg", "sensor_msgs/msg/JointState"), {"zstd"})


def test_collect_schema_text_matches_erban_recorder(recording):
    schemas = {s.name: s.data.decode() for items in recording["messages"].values() for s, _, _ in items}
    assert schemas == {name: SCHEMAS[name] for name in schemas} and len(schemas) == 4


def test_collect_stats_while_running_and_after_stop(recording):
    final = recording["final"]
    late = final["topics"][LATE]
    counts = {topic: len(items) for topic, items in recording["messages"].items()}
    assert (
        recording["running"]["topics"]["/joint_states"]["received"] > 0,
        {topic: s["received"] for topic, s in final["topics"].items()} == counts,
        final["written"] == sum(counts.values()),
        (late["gaps"], late["publisher_restarts"], late["last_header_stamp_ns"]),
        0 < late["latency_ns"]["p50"] < 10**9,
    ) == (True, True, True, (0, 1, late_stamps()[-1]), True)


MIXED = "/collect/mixed"
MIXED_COUNT = 60


def test_collect_takes_history_of_transient_local_publisher_joining_volatile_topic(tmp_path):
    """先有 volatile 发布端并已订上, 后上线 transient_local 发布端: 补取其历史, 两个发布端的消息都不重不丢."""
    rz = rosz.connect()
    container_publish("mixed_volatile", MIXED_COUNT, detach=True)
    path = tmp_path / "mixed.mcap"
    collector = rz.collect(str(path), [MIXED])
    deadline = time.monotonic() + 10
    while collector.stats()["topics"].get(MIXED, {}).get("received", 0) < 5 and time.monotonic() < deadline:
        time.sleep(0.05)
    container_publish("mixed_latched", 1)
    # 等 volatile 发布端发完 (20 Hz) 并退出
    time.sleep(MIXED_COUNT / 20 + 1)
    final = collector.stop()
    _, _, messages = read_mcap(path)
    texts = [cdr_string(m.data) for _, _, m in messages[MIXED]]
    assert (
        [t for t in texts if t.startswith("t")],
        [t for t in texts if t.startswith("v")],
        final["topics"][MIXED]["received"],
    ) == (["t0", "t1", "t2"], [f"v{i}" for i in range(MIXED_COUNT)], MIXED_COUNT + 3)


def test_message_carries_publisher_sequence():
    rz = rosz.connect()
    with rz.subscribe(["/joint_states"]) as subscription:
        first, second = subscription.recv(timeout=5), subscription.recv(timeout=5)
    assert (first.sequence > 0, second.sequence - first.sequence) == (True, 1)


def test_cli_collect(tmp_path):
    path = tmp_path / "cli.mcap"
    result = subprocess.run(
        [os.environ["ROSZ_BIN"], "collect", "/joint_states", "/tf_static", "--out", str(path), "--seconds", "2"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    stats = json.loads(result.stdout)
    _, _, messages = read_mcap(path)
    assert (
        {topic: s["received"] for topic, s in stats["topics"].items()} == {t: len(m) for t, m in messages.items()},
        90 < len(messages["/joint_states"]) < 110,
        len(messages["/tf_static"]),
    ) == (True, True, 1)


def test_cli_collect_stops_on_sigint_while_printing_stats(tmp_path):
    """统计打印得很频繁时 Ctrl-C 也不丢: 收到即封口退出, 输出最终统计."""
    command = [os.environ["ROSZ_BIN"], "--json", "collect", "/joint_states", "--out", str(tmp_path / "sigint.mcap")]
    exits = []
    for _ in range(5):
        process = subprocess.Popen([*command, "--stats-interval", "0.0005"], stdout=subprocess.PIPE, text=True)
        time.sleep(1)
        process.send_signal(signal.SIGINT)
        try:
            stdout, _ = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, _ = process.communicate()
        exits.append((process.returncode, "/joint_states" in stdout.splitlines()[-1]))
    assert exits == [(0, True)] * 5
