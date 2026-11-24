"""在 jazzy 容器里生成解码金样本: 按当前 RMW_IMPLEMENTATION 用 rclpy `serialize_message` 序列化, 参照值取 rclpy 消息对象.

用法 (容器内, 见 setup.sh): python3 golden.py <输出目录>
输出: <输出目录>/<rmw>/<样例>.cdr, <输出目录>/expected.json (样例 -> 类型与参照值), <输出目录>/hashes.json (类型 -> rosidl RIHS01, 含 .srv)
"""

import array
import glob
import io
import json
import os
import sys

import numpy as np
from PIL import Image as PilImage
from rclpy.serialization import serialize_message
from test_msgs import message_fixtures

from builtin_interfaces.msg import Time
from geometry_msgs.msg import TransformStamped
from hand.msg import PressureSensor
from sensor_msgs.msg import CameraInfo, CompressedImage, Image, JointState, PointCloud2, PointField
from std_msgs.msg import Header
from tf2_msgs.msg import TFMessage

TEST_MSGS = [
    "Builtins", "Empty", "BasicTypes", "Constants", "Defaults", "Strings", "Nested", "Arrays",
    "BoundedPlainSequences", "BoundedSequences", "UnboundedSequences", "MultiNested", "WStrings",
]


def header(frame_id):
    return Header(stamp=Time(sec=1763600000, nanosec=123456789), frame_id=frame_id)


def test_jpeg():
    """64x48 渐变图的 JPEG."""
    y, x = np.mgrid[0:48, 0:64]
    rgb = np.stack([x * 4, y * 5, (x + y) * 2], axis=-1).astype(np.uint8)
    buffer = io.BytesIO()
    PilImage.fromarray(rgb).save(buffer, format="JPEG", quality=95)
    return buffer.getvalue()


def sensor_samples():
    joint_state = JointState(header=header("base"), name=[f"joint{i}" for i in range(7)])
    joint_state.position = [0.1 * i for i in range(7)]
    joint_state.velocity = [-0.5 * i for i in range(7)]
    # effort 留空: 以空 float64[] 结尾时 fastcdr 多写 4 字节 (宽容性用例)

    depth = Image(header=header("depth"), height=6, width=8, encoding="16UC1", is_bigendian=0, step=16)
    depth.data = (np.arange(48, dtype="<u2") * 37).tobytes()

    cloud = PointCloud2(header=header("lidar"), height=1, width=4, is_bigendian=False, point_step=12, row_step=48)
    cloud.fields = [PointField(name=n, offset=4 * i, datatype=PointField.FLOAT32, count=1) for i, n in enumerate("xyz")]
    cloud.data = np.arange(12, dtype="<f4").tobytes()
    cloud.is_dense = True

    info = CameraInfo(header=header("color"), height=720, width=1280, distortion_model="plumb_bob")
    info.d = [0.1, -0.2, 0.001, 0.002, 0.0]
    info.k = [900.0, 0.0, 640.0, 0.0, 900.0, 360.0, 0.0, 0.0, 1.0]

    transforms = []
    for i, child in enumerate(["base", "head", "hand"]):
        t = TransformStamped(header=header("world"), child_frame_id=child)
        t.transform.translation.x, t.transform.translation.y, t.transform.translation.z = 1.0 * i, -0.5, 0.25
        t.transform.rotation.w = 1.0
        transforms.append(t)

    pressure = PressureSensor(header=header("left_hand"), pressure=[1.5, 2.5, 0.0, 3.25, 4.0, 0.0])

    return {
        "sensor_msgs.JointState": joint_state,
        "sensor_msgs.CompressedImage": CompressedImage(header=header("color"), format="rgb8; jpeg compressed bgr8", data=test_jpeg()),
        "sensor_msgs.Image": depth,
        "sensor_msgs.PointCloud2": cloud,
        "sensor_msgs.CameraInfo": info,
        "tf2_msgs.TFMessage": TFMessage(transforms=transforms),
        "hand.PressureSensor": pressure,
    }


def samples():
    out = {}
    for name in TEST_MSGS:
        for i, msg in enumerate(message_fixtures.get_test_msg(name)):
            out[f"test_msgs.{name}.{i}"] = msg
    out.update(sensor_samples())
    return out


def plain(value):
    """rclpy 值转 JSON: byte 为 int, 数组为列表."""
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


def type_name(msg):
    module = type(msg).__module__.split(".")[0]
    return f"{module}/msg/{type(msg).__name__}"


def rosidl_hashes():
    hashes = {}
    # .srv 的 json 含顶层类型与合成的 _Request/_Response/_Event, 四个都收
    # (只收 rosz 内置或追加了 .srv 的包: messages/ 下有 srv 目录的)
    srv = [p for p in glob.glob("/opt/ros/jazzy/share/*/srv/*.json") if glob.glob(f"/rosz/messages/*/{p.split('/')[-3]}/srv")]
    for path in glob.glob("/opt/ros/jazzy/share/*/msg/*.json") + glob.glob("/ws/install/share/*/msg/*.json") + srv:
        with open(path) as f:
            data = json.load(f)
        name = data["type_description_msg"]["type_description"]["type_name"]
        names = [name] + [name + s for s in ("_Request", "_Response", "_Event")] if "/srv/" in name else [name]
        for n in names:
            hashes[n] = next(h["hash_string"] for h in data["type_hashes"] if h["type_name"] == n)
    return dict(sorted(hashes.items()))


def main(out_dir):
    rmw = os.environ["RMW_IMPLEMENTATION"]
    os.makedirs(f"{out_dir}/{rmw}", exist_ok=True)
    expected = {}
    for case, msg in samples().items():
        with open(f"{out_dir}/{rmw}/{case}.cdr", "wb") as f:
            f.write(serialize_message(msg))
        expected[case] = {"type": type_name(msg), "value": plain(msg)}
    with open(f"{out_dir}/expected.json", "w") as f:
        json.dump(expected, f, indent=1, ensure_ascii=False, allow_nan=False)
    with open(f"{out_dir}/hashes.json", "w") as f:
        json.dump(rosidl_hashes(), f, indent=1)
    print(f"{rmw}: {len(expected)} 样例")


if __name__ == "__main__":
    main(sys.argv[1])
