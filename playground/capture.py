"""录一段真实话题的原始CDR, 给playground回放 (不进包, 录下的数据不入库).

用法: ROSZ_ROUTER=tcp/<orin>:7447 python capture.py <输出目录> [秒数]
输出: <目录>/<序号>.bin (每条: u64接收纳秒, i64采样纳秒 (无为-1), u32长度, 内容) 与 manifest.json (话题, 类型);
内容为原始CDR; 另有一路由对齐深度 (compressedDepth) 的真实像素按erban sensors载荷 (`16UC1; zstd`: u16宽, u16高 + zstd帧)
重新编码, 内容为图像载荷本身 (现场realsense驱动没有这一格式). 深度另在 expected.json 记首帧几处像素的 Python `depth()` 毫米值.
"""

import json
import struct
import sys
import time
from pathlib import Path

import rosz
import zstandard

TOPICS = [
    "/zj_humanoid/sensor/realsense_head/color/image_raw/compressed",
    "/zj_humanoid/sensor/realsense_head/aligned_depth_to_color/image_raw/compressedDepth",
    "/zj_humanoid/upperlimb/joint_states",
    "/tf",
]
ALIGNED = "/zj_humanoid/sensor/realsense_head/aligned_depth_to_color/image_raw/compressedDepth"
DERIVED = "/derived/aligned_depth/zstd"
# 对照的像素 (列, 行), 按图像尺寸的比例取
PROBES = [(0.5, 0.5), (0.25, 0.25), (0.75, 0.6), (0.1, 0.9)]

out = Path(sys.argv[1])
seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
out.mkdir(parents=True, exist_ok=True)
rz = rosz.connect()
types = {t.name: t.type for t in rz.topics()}
names = TOPICS + [DERIVED]
files = {topic: open(out / f"{index}.bin", "wb") for index, topic in enumerate(names)}
compressor = zstandard.ZstdCompressor(level=1)
expected = {}
deadline = time.time() + seconds
with rz.subscribe(TOPICS) as sub:
    while time.time() < deadline:
        msg = sub.recv(timeout=1.0)
        if msg is None:
            continue
        payload = msg.payload
        sample = msg.sample_time_ns if msg.sample_time_ns is not None else -1
        files[msg.topic].write(struct.pack("<QqI", msg.receive_time_ns, sample, len(payload)) + payload)
        if msg.topic == ALIGNED:
            depth = msg.depth()
            height, width = depth.shape
            image = struct.pack("<HH", width, height) + compressor.compress(depth.astype("<u2").tobytes())
            files[DERIVED].write(struct.pack("<QqI", msg.receive_time_ns, sample, len(image)) + image)
            if msg.topic not in expected:
                points = [(int(width * u), int(height * v)) for u, v in PROBES]
                expected[msg.topic] = expected[DERIVED] = {
                    "receive_time_ns": str(msg.receive_time_ns),
                    "width": width,
                    "height": height,
                    "probes": [{"x": x, "y": y, "mm": int(depth[y, x])} for x, y in points],
                }
for f in files.values():
    f.close()
manifest = [{"file": f"{index}.bin", "topic": topic, "type": types.get(topic)} for index, topic in enumerate(TOPICS)]
manifest.append({"file": f"{len(TOPICS)}.bin", "topic": DERIVED, "type": None, "format": "16UC1; zstd"})
(out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
(out / "expected.json").write_text(json.dumps(expected, ensure_ascii=False, indent=1))
print(json.dumps({"files": {t: (out / f"{i}.bin").stat().st_size for i, t in enumerate(names)}, "expected": expected}, indent=1))
