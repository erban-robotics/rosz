"""服务互通测试的 rclpy 对端 (jazzy 容器内).

用法:
  python3 service.py server <服务名>                      SetBool 服务端: success=data, message="rclpy <data>"; 先打印 "ready", 一直服务到被杀
  python3 service.py client <包/srv/类型> <服务名> <JSON>...  等服务 (10 s), 依次按 JSON (字段 -> 值, 可嵌套 dict) 调用,
                                                         每个应答打印一行 JSON (值同 listen.py); 服务不可用时退出码 1
"""

import importlib
import json
import sys

import rclpy

from listen import plain


def fill(msg, values):
    types = msg.get_fields_and_field_types()
    for field, value in values.items():
        if isinstance(value, dict):
            fill(getattr(msg, field), value)
        elif types[field] == "octet":
            setattr(msg, field, bytes([value]))
        else:
            setattr(msg, field, value)
    return msg


def server(node, name):
    from std_srvs.srv import SetBool

    def handle(request, response):
        response.success = request.data
        response.message = f"rclpy {request.data}"
        return response

    node.create_service(SetBool, name, handle)
    print("ready", flush=True)
    rclpy.spin(node)


def client(node, srv_type, name, requests):
    package, _, type_name = srv_type.split("/")
    srv = getattr(importlib.import_module(f"{package}.srv"), type_name)
    cli = node.create_client(srv, name)
    if not cli.wait_for_service(timeout_sec=10.0):
        sys.exit(1)
    for request in requests:
        future = cli.call_async(fill(srv.Request(), json.loads(request)))
        rclpy.spin_until_future_complete(node, future, timeout_sec=10.0)
        print(json.dumps(plain(future.result())), flush=True)


def main():
    rclpy.init()
    node = rclpy.create_node("rosz_service_peer")
    if sys.argv[1] == "server":
        server(node, sys.argv[2])
    else:
        client(node, sys.argv[2], sys.argv[3], sys.argv[4:])
    node.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    main()
