"""互通测试的发布端 (jazzy 容器内, RMW_IMPLEMENTATION=rmw_zenoh_cpp): 内容确定, 便于对照.

用法: python3 publish.py <参照输出目录>
话题:
- /joint_states             JointState 50 Hz (effort 为空)
- /tf                       TFMessage 10 Hz
- /tf_static                TFMessage, transient_local, 只发一次
- /hand/pressure            hand/PressureSensor 10 Hz (erban 自定义)
- /head/color/compressed    CompressedImage JPEG 1280x720, 按需发布 (有订阅端才发)
- /head/depth/zstd          CompressedImage `16UC1; zstd` 640x360 (已对齐到彩色, 2x 降采样), 按需发布
- /head/depth/png           CompressedImage `16UC1; compressedDepth png` 640x360, 按需发布
- /wrist/depth/zstd         CompressedImage `16UC1; zstd` 640x480 (未对齐, 与彩色不成整数倍)
- /test/basic               test_msgs/BasicTypes (rosz 不内置 test_msgs: 无法解码)
- /silent                   JointState, 有发布端但从不发
参照: <目录>/expected.json (话题 -> rclpy 值), <目录>/color.jpg
"""

import array
import io
import json
import os
import struct
import sys

import numpy as np
import rclpy
import zstandard
from PIL import Image as PilImage
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile

from builtin_interfaces.msg import Time
from geometry_msgs.msg import TransformStamped
from hand.msg import PressureSensor
from sensor_msgs.msg import CompressedImage, JointState
from std_msgs.msg import Header
from test_msgs.msg import BasicTypes
from tf2_msgs.msg import TFMessage

STAMP = Time(sec=1763600000, nanosec=500000000)


def depth_array(width, height):
    """确定的深度图案 (毫米): 便于对照."""
    y, x = np.mgrid[0:height, 0:width]
    depth = ((x * 3 + y * 5) % 4000 + 200).astype("<u2")
    depth[0, 0] = 0  # 一个无效点
    return depth


def zstd_depth(depth):
    height, width = depth.shape
    return struct.pack("<HH", width, height) + zstandard.ZstdCompressor(level=1).compress(depth.tobytes())


def png_depth(depth):
    buffer = io.BytesIO()
    PilImage.fromarray(depth.astype(np.uint16)).save(buffer, format="PNG")
    # compressed_depth_image_transport ConfigHeader: int32 格式 + float32[2] 量化参数
    return struct.pack("<iff", 0, 0.0, 0.0) + buffer.getvalue()


def color_jpeg():
    y, x = np.mgrid[0:720, 0:1280]
    rgb = np.stack([x % 256, y % 256, (x // 5 + y // 3) % 256], axis=-1).astype(np.uint8)
    buffer = io.BytesIO()
    PilImage.fromarray(rgb).save(buffer, format="JPEG", quality=90)
    return buffer.getvalue()


def plain(value):
    if hasattr(value, "get_fields_and_field_types"):
        return {f: plain(getattr(value, f)) for f in value.get_fields_and_field_types()}
    if isinstance(value, bytes) and len(value) == 1:
        return value[0]
    if isinstance(value, (bytes, bytearray, array.array)):
        return list(value)
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    return value


class Publisher(Node):
    def __init__(self, out_dir):
        super().__init__("rosz_test_publisher")
        header = lambda frame: Header(stamp=STAMP, frame_id=frame)  # noqa: E731
        joint = JointState(header=header("base"), name=[f"joint{i}" for i in range(7)])
        joint.position = [0.1 * i for i in range(7)]
        joint.velocity = [-0.25 * i for i in range(7)]
        transforms = []
        for i, child in enumerate(["base", "head", "hand"]):
            t = TransformStamped(header=header("world"), child_frame_id=child)
            t.transform.translation.x = 1.0 * i
            t.transform.rotation.w = 1.0
            transforms.append(t)
        jpeg = color_jpeg()
        self.messages = {
            "/joint_states": (joint, 50, False),
            "/tf": (TFMessage(transforms=transforms), 10, False),
            "/hand/pressure": (PressureSensor(header=header("left_hand"), pressure=[1.5, 2.5, 0.0, 3.25, 4.0, 0.0]), 10, False),
            "/head/color/compressed": (CompressedImage(header=header("color"), format="rgb8; jpeg compressed bgr8", data=jpeg), 15, True),
            "/head/depth/zstd": (CompressedImage(header=header("depth"), format="16UC1; zstd", data=zstd_depth(depth_array(640, 360))), 15, True),
            "/head/depth/png": (CompressedImage(header=header("depth"), format="16UC1; compressedDepth png", data=png_depth(depth_array(640, 360))), 15, True),
            "/wrist/depth/zstd": (CompressedImage(header=header("wrist"), format="16UC1; zstd", data=zstd_depth(depth_array(640, 480))), 15, True),
            "/test/basic": (BasicTypes(int32_value=-7, float64_value=2.5), 10, False),
        }
        self.publishers_ = {}
        for topic, (msg, rate, _) in self.messages.items():
            self.publishers_[topic] = self.create_publisher(type(msg), topic, 10)
            self.create_timer(1.0 / rate, lambda topic=topic: self.tick(topic))
        self.create_publisher(JointState, "/silent", 10)
        static = TFMessage(transforms=transforms[:1])
        latched = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self.create_publisher(TFMessage, "/tf_static", latched).publish(static)

        os.makedirs(out_dir, exist_ok=True)
        expected = {topic: plain(msg) for topic, (msg, _, _) in self.messages.items()}
        expected["/tf_static"] = plain(static)
        with open(f"{out_dir}/expected.json", "w") as f:
            json.dump(expected, f)
        with open(f"{out_dir}/color.jpg", "wb") as f:
            f.write(jpeg)
        self.get_logger().info("就绪")

    def tick(self, topic):
        msg, _, on_demand = self.messages[topic]
        publisher = self.publishers_[topic]
        if not on_demand or publisher.get_subscription_count() > 0:
            publisher.publish(msg)


def main():
    rclpy.init()
    rclpy.spin(Publisher(sys.argv[1]))


if __name__ == "__main__":
    main()
