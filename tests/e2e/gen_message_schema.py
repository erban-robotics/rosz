"""生成采集互通测试的 schema 对照: erban-caring webapp 录制器写 MCAP 用的 `episode_data.message_schema` 原样输出.

只载 `episode_data/_mcap.py` (不跑包 `__init__`, 免得拉进 cv2 与 erban_utils), 依赖版本同 webapp requirements.txt:
    uv run --no-project --python 3.12 --with rosbags==0.11.8 --with mcap==1.4.0 --with mcap-ros2-support==0.5.7 \
        --with numpy python tests/e2e/gen_message_schema.py ~/projects/erban-caring/pc/webapp
写到本目录 message_schema.json (类型名 -> schema 文本).
"""

import json
import sys
import types
from pathlib import Path

# 采集互通测试录到的类型, 加上 webapp 录制话题的其余类型 (audio_common_msgs 除外: rosz 不内置)
TYPES = [
    "sensor_msgs/msg/JointState",
    "std_msgs/msg/String",
    "hand/msg/PressureSensor",
    "tf2_msgs/msg/TFMessage",
    "sensor_msgs/msg/CompressedImage",
    "sensor_msgs/msg/Image",
    "sensor_msgs/msg/CameraInfo",
    "geometry_msgs/msg/WrenchStamped",
    "geometry_msgs/msg/PoseStamped",
]


def main():
    package = types.ModuleType("episode_data")
    package.__path__ = [str(Path(sys.argv[1]).expanduser() / "episode_data")]
    sys.modules["episode_data"] = package
    from episode_data._mcap import message_schema

    out = Path(__file__).with_name("message_schema.json")
    out.write_text(json.dumps({t: message_schema(t) for t in TYPES}, indent=1, ensure_ascii=False) + "\n")
    print(out)


if __name__ == "__main__":
    main()
