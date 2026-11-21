"""互通测试: 一次性 jazzy 容器 (rmw_zenoh_cpp 0.2.11) 发布, 本机无 ROS 环境用 rosz wheel 与 CLI 接收.

由 scripts/jazzy/e2e.sh 运行; 需环境变量 ROSZ_ROUTER, ROSZ_BIN (CLI), ROSZ_E2E_REF (发布端写的参照目录).
发布内容见 scripts/jazzy/publish.py.
"""

import io
import json
import os
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

import rosz

REF = Path(os.environ["ROSZ_E2E_REF"])
EXPECTED = json.loads((REF / "expected.json").read_text())
COLOR, HEAD_ZSTD, HEAD_PNG, WRIST = "/head/color/compressed", "/head/depth/zstd", "/head/depth/png", "/wrist/depth/zstd"


def depth_pattern(width, height):
    y, x = np.mgrid[0:height, 0:width]
    depth = ((x * 3 + y * 5) % 4000 + 200).astype(np.uint16)
    depth[0, 0] = 0
    return depth


def cli(*args, env=None):
    return subprocess.run([os.environ["ROSZ_BIN"], *args], capture_output=True, text=True, env=env, timeout=60)


@pytest.fixture(scope="module")
def rz():
    return rosz.connect()


# ---------------- Python wheel ----------------


def test_image_and_depth_match_published(rz):
    color = rz.latest(COLOR).image()
    reference = np.asarray(Image.open(REF / "color.jpg").convert("RGB"), dtype=np.int16)
    problems = []
    if color.shape != reference.shape or np.abs(color.astype(np.int16) - reference).mean() > 1.0:
        problems.append(COLOR)
    for topic, (w, h) in [(HEAD_ZSTD, (640, 360)), (HEAD_PNG, (640, 360)), (WRIST, (640, 480))]:
        depth = rz.latest(topic).depth()
        if depth.dtype != np.uint16 or not np.array_equal(depth, depth_pattern(w, h)):
            problems.append(topic)
    assert problems == []


def test_depth_at_color_pixel(rz):
    aligned = rz.aligned(depth=HEAD_ZSTD, color=COLOR).latest()
    pattern = depth_pattern(640, 360)
    points = [(0, 0), (1, 1), (1279, 719), (640, 361), (333, 77)]
    got = [aligned.depth_at(u, v) for u, v in points] + [aligned.error]
    unaligned = rz.aligned(depth=WRIST, color=COLOR).latest()
    got += [unaligned.depth_at(10, 10), "未对齐" in unaligned.error]
    assert got == [int(pattern[v // 2, u // 2]) for u, v in points] + [None, None, True]


def test_expected_failures_are_return_values(rz):
    undecodable = rz.latest("/test/basic")
    with pytest.raises(rosz.TopicNotFound) as typo:
        rz.latest("/joint_state")
    env = {k: v for k, v in os.environ.items() if k != "ROSZ_ROUTER"}
    no_router = subprocess.run(
        ["python", "-c", "import rosz; rosz.connect()"], capture_output=True, text=True, env=env
    )
    assert [
        rz.latest("/silent", timeout=0.5),
        undecodable.value,
        undecodable.error,
        typo.value.candidates[0],
        "ConnectionError" in no_router.stderr,
    ] == [None, None, "无定义", "/joint_states", True]


# ---------------- CLI ----------------


def test_cli_static_when_any_publisher_is_transient_local():
    topics = {t["name"]: t for t in json.loads(cli("topics", "--json").stdout)["topics"]}
    latched = json.loads(cli("echo", "/mixed_durability", "-n", "1", "--timeout", "3", "--json").stdout)
    assert (topics["/mixed_durability"]["transient_local"], latched.get("value")) == (True, {"data": "latched"})


def test_cli_echo_matches_rclpy():
    wrong = []
    for topic in ["/joint_states", "/tf", "/tf_static", "/hand/pressure", COLOR]:
        result = cli("echo", topic, "-n", "1", "--json")
        value = json.loads(result.stdout)["value"]
        expected = EXPECTED[topic]
        if topic == COLOR:
            # uint8[] 在 JSON 里只给长度与开头
            expected = {**expected, "data": {"length": len(expected["data"]), "head": expected["data"][:16]}}
        if value != expected:
            wrong.append(topic)
    assert wrong == []


def test_cli_topics_lists_types_and_decodability():
    topics = {t["name"]: t for t in json.loads(cli("topics", "--json").stdout)["topics"]}
    assert [(topics[n]["type"], topics[n]["decodable"]) for n in ["/joint_states", "/hand/pressure", COLOR, "/test/basic"]] == [
        ("sensor_msgs/msg/JointState", True),
        ("hand/msg/PressureSensor", True),
        ("sensor_msgs/msg/CompressedImage", True),
        ("test_msgs/msg/BasicTypes", False),
    ]


def test_cli_snapshot_writes_files_and_manifest(tmp_path):
    manifest = json.loads(cli("snapshot", COLOR, HEAD_ZSTD, HEAD_PNG, "/joint_states", "--out", str(tmp_path)).stdout)
    items = {i["topic"]: i for i in manifest["items"]}
    keys = {"topic", "type", "kind", "files", "receive_time_ns", "sample_time_ns", "receive_offset_ms", "sample_offset_ms"}
    depth_png = np.asarray(Image.open(items[HEAD_ZSTD]["files"][0]))
    assert [
        all(keys <= set(i) and all(Path(f).exists() for f in i["files"]) for i in items.values()),
        [i["kind"] for i in items.values()],
        Image.open(items[COLOR]["files"][0]).format,
        np.array_equal(depth_png, depth_pattern(640, 360)),
        (tmp_path / "manifest.json").exists(),
    ] == [True, ["color", "depth", "depth", "message"], "JPEG", True, True]


def test_cli_unknown_topic_gives_candidates():
    result = cli("echo", "/joint_state", "--json")
    assert (result.returncode != 0, json.loads(result.stdout)["error"]["candidates"][:1]) == (True, ["/joint_states"])


def test_cli_output_is_json_in_pipe_and_text_in_terminal():
    piped = cli("echo", "/joint_states", "-n", "1")
    command = f"{os.environ['ROSZ_BIN']} echo /joint_states -n 1"
    terminal = subprocess.run(["script", "-qc", command, "/dev/null"], capture_output=True, text=True, timeout=60)
    assert (json.loads(piped.stdout)["topic"], terminal.stdout.splitlines()[0].strip()) == ("/joint_states", "header:")


def test_cli_stats():
    stats = json.loads(cli("stats", "/joint_states", "--seconds", "2").stdout)["topics"][0]
    assert (round(stats["rate_hz"]), stats["fields"]["position[1]"], stats["size_bytes"]["min"] > 0) == (
        50,
        pytest.approx({"min": 0.1, "max": 0.1, "mean": 0.1}),
        True,
    )
