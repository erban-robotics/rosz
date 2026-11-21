"""查看器 3D 面板手动验收的发布端 (jazzy 容器内, RMW_IMPLEMENTATION=rmw_zenoh_cpp). 不进互通测试: 会往 /tf 与
/tf_static 添发布端, 与 publish.py 的参照值混在一起.

用法 (先 scripts/jazzy/start.sh):
    docker exec -d rosz-jazzy bash -c 'source /opt/ros/jazzy/setup.bash; export RMW_IMPLEMENTATION=rmw_zenoh_cpp;
        exec python3 /rosz/scripts/jazzy/publish_3d.py > /tmp/publish_3d.log 2>&1'
过一会儿再开 `rosz view --router tcp/127.0.0.1:7447`: 静态变换应照样显示.

话题:
- /tf_static   两个 tf2_ros static_transform_publisher (真 transient_local, 只在启动时发一次):
               base -> camera_link (前 0.1 m, 高 1.2 m), camera_link -> camera_color_optical_frame (光学系: z 朝前, x 朝右)
- /tf          base -> rotor 30 Hz: 绕 base 半径 0.5 m, 高 0.3 m 转圈, 每 2 秒一圈, 自身同步转
- /view/points/camera   PointCloud2 10 Hz, 坐标系 camera_color_optical_frame: 相机前方 1.5 m 处起伏的面, 带 rgb
- /view/points/rotor    PointCloud2 10 Hz, 坐标系 rotor: 半径 0.15 m 的圆环, 只有 xyz
publish.py 另有 /tf (world -> base, head, hand) 与 /tf_static (world -> base); 树根为 world.
"""

import math
import subprocess

import numpy as np
import rclpy
from geometry_msgs.msg import TransformStamped
from rclpy.node import Node
from sensor_msgs.msg import PointCloud2, PointField
from std_msgs.msg import Header
from tf2_msgs.msg import TFMessage

STATIC = [
    ["--x", "0.1", "--z", "1.2", "--frame-id", "base", "--child-frame-id", "camera_link"],
    ["--roll", str(-math.pi / 2), "--yaw", str(-math.pi / 2), "--frame-id", "camera_link", "--child-frame-id", "camera_color_optical_frame"],
]
XYZ = [PointField(name=n, offset=4 * i, datatype=PointField.FLOAT32, count=1) for i, n in enumerate("xyz")]
XYZRGB = XYZ + [PointField(name="rgb", offset=12, datatype=PointField.FLOAT32, count=1)]


def cloud(header, fields, points, width, height):
    data = np.ascontiguousarray(points).tobytes()
    step = 4 * len(fields)
    return PointCloud2(header=header, height=height, width=width, fields=fields, is_bigendian=False,
                       point_step=step, row_step=step * width, data=data, is_dense=True)


class Publisher(Node):
    def __init__(self):
        super().__init__("rosz_view_3d_publisher")
        self.tf = self.create_publisher(TFMessage, "/tf", 10)
        self.camera = self.create_publisher(PointCloud2, "/view/points/camera", 10)
        self.rotor = self.create_publisher(PointCloud2, "/view/points/rotor", 10)
        self.start = self.get_clock().now()
        self.create_timer(1 / 30, self.tick_tf)
        self.create_timer(1 / 10, self.tick_clouds)

    def elapsed(self):
        return (self.get_clock().now() - self.start).nanoseconds / 1e9

    def header(self, frame):
        return Header(stamp=self.get_clock().now().to_msg(), frame_id=frame)

    def tick_tf(self):
        angle = self.elapsed() * math.pi
        t = TransformStamped(header=self.header("base"), child_frame_id="rotor")
        t.transform.translation.x = 0.5 * math.cos(angle)
        t.transform.translation.y = 0.5 * math.sin(angle)
        t.transform.translation.z = 0.3
        t.transform.rotation.z = math.sin(angle / 2)
        t.transform.rotation.w = math.cos(angle / 2)
        self.tf.publish(TFMessage(transforms=[t]))

    def tick_clouds(self):
        width, height = 160, 120
        v, u = np.mgrid[0:height, 0:width].astype(np.float32)
        z = 1.5 + 0.1 * np.sin(u / 10 + self.elapsed() * 2)
        x = (u - width / 2) / 100 * z
        y = (v - height / 2) / 100 * z
        r, g = (u / width * 255).astype(np.uint32), (v / height * 255).astype(np.uint32)
        rgb = ((r << 16) | (g << 8) | 200).astype(np.uint32).view(np.float32)
        points = np.stack([x, y, z, rgb], axis=-1).astype(np.float32)
        self.camera.publish(cloud(self.header("camera_color_optical_frame"), XYZRGB, points, width, height))
        theta = np.linspace(0, 2 * math.pi, 120, endpoint=False, dtype=np.float32)
        ring = np.stack([0.15 * np.cos(theta), 0.15 * np.sin(theta), np.zeros_like(theta)], axis=-1)
        self.rotor.publish(cloud(self.header("rotor"), XYZ, ring, len(theta), 1))


def main():
    statics = [subprocess.Popen(["ros2", "run", "tf2_ros", "static_transform_publisher", *args]) for args in STATIC]
    rclpy.init()
    try:
        rclpy.spin(Publisher())
    finally:
        for process in statics:
            process.terminate()


if __name__ == "__main__":
    main()
