"""互通测试: 服务. rosz server 由 jazzy 容器内 rclpy client 与 `ros2 service call` 调, rosz client 调容器内 rclpy server.

由 scripts/jazzy/e2e.sh 运行; 另需环境变量 ROSZ_JAZZY_CONTAINER (容器名). 容器内 rclpy 对端见 scripts/jazzy/service.py,
带 Receipt 的 erban 服务用 scripts/jazzy/erban_interfaces.sh 现编.
"""

import json
import os
import shlex
import subprocess
import threading
import time
from pathlib import Path

import pytest

import rosz

CONTAINER = os.environ["ROSZ_JAZZY_CONTAINER"]
REPO = Path(__file__).resolve().parents[2]
ERBAN_SETUP = "source /ws/erban/share/erban_interfaces/local_setup.bash"


@pytest.fixture(scope="module")
def rz():
    return rosz.connect(msg_dirs=[str(REPO / "messages/test")])


def in_container(command, timeout=30):
    full = f"source /env.sh; {ERBAN_SETUP} 2>/dev/null; {command}"
    return subprocess.run(["docker", "exec", CONTAINER, "bash", "-c", full], capture_output=True, text=True, timeout=timeout)


def rclpy_call(srv_type, name, *requests):
    """容器内 rclpy client 依次调用, 返回各应答 (dict)."""
    args = shlex.join(["/rosz/scripts/jazzy/service.py", "client", srv_type, name, *map(json.dumps, requests)])
    out = in_container(f"cd /rosz/scripts/jazzy && python3 {args}")
    return [json.loads(line) for line in out.stdout.splitlines()]


def set_bool(request, response):
    response["success"] = not request["data"]
    response["message"] = f"rosz {request['data']} {threading.current_thread() is threading.main_thread()}"
    return response


def test_rclpy_client_calls_rosz_server(rz):
    with rz.create_service("std_srvs/srv/SetBool", "/rosz/set_bool", set_bool):
        got = rclpy_call("std_srvs/srv/SetBool", "/rosz/set_bool", {"data": True}, {"data": False})
    # handler 不在主线程跑; 两次调用 (请求序号 1, 2) 都应答到
    assert got == [{"success": False, "message": "rosz True False"}, {"success": True, "message": "rosz False False"}]


def test_rclpy_client_round_trips_all_basic_types(rz):
    request = {
        "bool_value": True, "byte_value": 255, "char_value": 65, "float32_value": 1.5, "float64_value": -2.25,
        "int8_value": -128, "uint8_value": 255, "int16_value": -3, "uint16_value": 65535, "int32_value": -(2**31),
        "uint32_value": 2**32 - 1, "int64_value": -(2**63), "uint64_value": 2**64 - 1, "string_value": "你好",
    }  # fmt: skip

    def echo(req, _response):
        return req

    with rz.create_service("test_msgs/srv/BasicTypes", "/rosz/basic", echo):
        got = rclpy_call("test_msgs/srv/BasicTypes", "/rosz/basic", request)
    assert got == [request]


def test_ros2_service_call_reaches_rosz_server(rz):
    with rz.create_service("std_srvs/srv/SetBool", "/rosz/cli_set_bool", set_bool):
        out = in_container("ros2 service call /rosz/cli_set_bool std_srvs/srv/SetBool '{data: true}'")
    assert "SetBool_Response(success=False, message='rosz True False')" in out.stdout


def test_rosz_client_calls_rclpy_server(rz):
    peer = subprocess.Popen(
        ["docker", "exec", CONTAINER, "bash", "-c", "source /env.sh; exec python3 /rosz/scripts/jazzy/service.py server /rclpy/set_bool"],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert peer.stdout.readline().strip() == "ready"
        client = rz.create_client("std_srvs/srv/SetBool", "/rclpy/set_bool")
        got = [client.wait_for_service(timeout_sec=10), client.call({"data": True}, timeout_sec=10)]
    finally:
        in_container("pkill -9 -f 'service[.]py server /rclpy/set_bool'")
        peer.wait(timeout=10)
    assert got == [True, {"success": True, "message": "rclpy True"}]


def test_receipt_reports_handler_failure(rz):
    subprocess.run([str(REPO / "scripts/jazzy/erban_interfaces.sh"), CONTAINER], check=True)

    def get_preset(request, response):
        if request["name"] == "boom":
            raise RuntimeError("预设坏了")
        response["preset_yaml"] = f"name: {request['name']}"
        return response

    with rz.create_service("erban_interfaces/srv/GetPreset", "/rosz/get_preset", get_preset):
        ok, failed = rclpy_call(
            "erban_interfaces/srv/GetPreset",
            "/rosz/get_preset",
            {"preset_type": "mpc", "name": "home"},
            {"preset_type": "mpc", "name": "boom"},
        )
    detail = json.loads(failed["receipt"]["detail_json"])
    assert (ok, failed["receipt"]["code"], failed["preset_yaml"], "预设坏了" in detail["traceback"]) == (
        {"receipt": {"code": 0, "message": "", "detail_json": ""}, "preset_yaml": "name: home"},
        5,
        "",
        True,
    )


def test_timeout_and_unreachable_return_none_instead_of_hanging(rz):
    def slow(request, response):
        time.sleep(3)
        return response

    with rz.create_service("std_srvs/srv/SetBool", "/rosz/slow", slow):
        client = rz.create_client("std_srvs/srv/SetBool", "/rosz/slow")
        nobody = rz.create_client("std_srvs/srv/SetBool", "/rosz/nobody")
        started = time.monotonic()
        got = [
            client.wait_for_service(timeout_sec=5),
            client.call({"data": True}, timeout_sec=0.3),
            nobody.wait_for_service(timeout_sec=0.3),
            nobody.call({"data": True}),
        ]
        elapsed = time.monotonic() - started  # 出 with 时会等手上的慢请求处理完, 所以在里面计时
    assert (got, elapsed < 2) == ([True, None, False, None], True)


def test_workers_run_handlers_concurrently(rz):
    def slow(request, response):
        time.sleep(1)
        return response

    with rz.create_service("std_srvs/srv/SetBool", "/rosz/parallel", slow, workers=2):
        client = rz.create_client("std_srvs/srv/SetBool", "/rosz/parallel")
        client.wait_for_service(timeout_sec=5)
        results = []
        threads = [threading.Thread(target=lambda: results.append(client.call({"data": True}))) for _ in range(2)]
        started = time.monotonic()
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    assert (len([r for r in results if r is not None]), time.monotonic() - started < 1.8) == (2, True)


def test_bad_request_and_unknown_type_are_rejected(rz):
    client = rz.create_client("std_srvs/srv/SetBool", "/rosz/set_bool")
    with pytest.raises(rosz.EncodeError) as bad:
        client.call({"data": "yes"})
    with pytest.raises(LookupError) as unknown:
        rz.create_client("nope/srv/Nope", "/rosz/nope")
    assert (bad.value.path, "nope/srv/Nope" in str(unknown.value)) == ("data", True)
