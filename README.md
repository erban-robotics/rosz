# rosz

不装 ROS 即可读取 ROS 2 (rmw_zenoh) 话题: 直连 Zenoh router, 靠 liveliness token 发现话题, 按内置 `.msg` (common_interfaces jazzy 全套 + erban 自定义) 通用解码, 并解码 JPEG 与深度 (`16UC1; zstd`, `16UC1; compressedDepth`). 同一份 Rust 代码出 Rust 库, Python wheel, 浏览器 WASM 与 `rosz` 命令行.

第一版只订阅, 不发布不调服务; 传输层直接用 `zenoh` crate 与自写的 rmw_zenoh 订阅端 (与现场 rmw_zenoh_cpp 0.2.11 对齐). 以后加发布与服务时, 传输层建在 hiroz 之上.

## 安装

产物都挂在 [GitHub Release](https://github.com/erban-robotics/rosz/releases), 不发公共平台. 以 `v0.1.0` 为例:

- Python (x86_64 / aarch64, Python 3.10+): `pip install rosz --find-links https://github.com/erban-robotics/rosz/releases/expanded_assets/v0.1.0`
- CLI: 下载 `rosz-0.1.0-linux-x86_64` (或 `-aarch64`), musl 静态二进制, `chmod +x` 即用
- npm (浏览器解码): `"@erban-robotics/rosz-wasm": "https://github.com/erban-robotics/rosz/releases/download/v0.1.0/erban-robotics-rosz-wasm-0.1.0.tgz"`. npm 12 起默认 `allow-remote=none`, 拒装远程 tgz, 需在项目 `.npmrc` 写 `allow-remote=all` (或安装时加 `--allow-remote=all`)
- Rust: `rosz-access = { git = "https://github.com/erban-robotics/rosz", tag = "v0.1.0" }` (只解码用 `rosz-decode`)

## router 地址

`--router` (Python 为 `connect(router=...)`) 优先, 其次环境变量 `ROSZ_ROUTER`, 都没有则报错; 不内置默认地址. 写法 `tcp/192.168.1.10:7447`, `192.168.1.10:7447` 或 `192.168.1.10` (端口默认 7447). ROS domain 取 `ROS_DOMAIN_ID` (默认 0).

## 命令行

终端里为人读格式; stdout 是管道或加 `--json` 时为结构固定的 JSON. 出错时非零退出码, JSON 模式下输出 `{"error": {"kind", "message", "candidates"}}`, 话题写错附最相近的候选.

```bash
export ROSZ_ROUTER=tcp/192.168.1.10:7447
rosz topics                         # 名称, 类型, 约 1 秒实测频率, 能否解码 (--no-rate 不测)
rosz echo /joint_states -n 1        # 大数组只显长度与开头; JSON 里 uint8[] 为 {"length", "head"}
rosz snapshot --out shots           # 默认全部图像话题, 每话题一条落文件, 输出清单
rosz stats /joint_states --seconds 3
```

`snapshot` 落文件: 彩色为 JPEG (压缩图原样, 原始图编码), 深度为 16 位 PNG (毫米) 加伪彩色预览 PNG, 其他消息为 JSON; 清单 (`manifest.json`, 同时打印) 含每个文件路径, 接收时间, 采样时间及二者相对快照时刻的偏差 (毫秒).

`--msg-dir <目录>` 可追加 `.msg` (目录内为 `<包>/msg/<类型>.msg`).

## Python

```python
import rosz

rz = rosz.connect()                                  # 或 rosz.connect("tcp/192.168.1.10:7447")
for t in rz.topics():
    print(t.name, t.type, t.decodable, t.reason)

msg = rz.latest("/head/color/compressed", timeout=2.0)   # 超时为 None
rgb = msg.image()                                    # (高, 宽, 3) uint8
depth = rz.latest("/head/depth/zstd").depth()        # (高, 宽) uint16 毫米, 原分辨率
msg.value                                            # dict, 数值数组为 numpy; 解不了为 None, 原因见 msg.error

frame = rz.aligned(depth="/head/depth/zstd", color="/head/color/compressed").latest()
frame.depth_at(640, 360)                             # 彩色像素 (列, 行) 处深度 (毫米); 未对齐时为 None, 原因见 frame.error

with rz.subscribe(["/joint_states", "/tf"]) as sub:
    for msg in sub:
        print(msg.topic, msg.receive_time_ns, msg.sample_time_ns)
```

按彩色像素查深度只支持深度已对齐到彩色 (视场相同, 分辨率成同一整数倍, 最近邻换算); 未对齐需内外参投影, 不做. 预期内失败用返回值; 只有程序错误 (话题不存在抛 `rosz.TopicNotFound`, 带 `candidates`) 与连接失败 (`ConnectionError`) 抛异常.

## Rust

```rust
let session = rosz_access::connect(Some("tcp/192.168.1.10:7447")).await?;
if let Some(msg) = session.latest("/joint_states", std::time::Duration::from_secs(2)).await? {
    println!("{:?}", msg.value()?.get("position"));
}
```

`rosz_decode::Registry` 可单独用: `Registry::builtin()` 含全部内置类型, `add_dir` 运行时追加, `decode(类型, CDR)` 出保持字段顺序的值树 (`uint8[]` 零拷贝), `rihs01(类型)` 由定义算 type hash.

## 浏览器 (WASM)

见 [bindings/wasm/README.md](bindings/wasm/README.md). 解码, zstd, 16 位 PNG 同一个模块, 约 310 KB (gzip 130 KB).

## 仓库布局

| 目录 | 内容 |
|---|---|
| `crates/decode` | `rosz-decode`: `.msg` 注册表, XCDR1 解码, RIHS01, 媒体解码 (JPEG 在 `jpeg` 开关后) |
| `crates/access` | `rosz-access`: rmw_zenoh 话题发现与订阅 |
| `apps/cli` | `rosz` 命令行 |
| `bindings/python` | PyO3 wheel |
| `bindings/wasm` | wasm-bindgen 模块与 npm 包 |
| `messages` | 内置 `.msg` 与解码金样本, 见 [messages/README.md](messages/README.md) |
| `scripts/jazzy` | 一次性 jazzy 容器 (rmw_zenoh_cpp 0.2.11): 生成金样本, 互通测试的发布端 |
| `tests/e2e` | 互通测试 (pytest) |

## 开发与测试

```bash
cargo test -p rosz-decode                  # 金样本回归: 逐字段对照 rclpy, 188 个类型 RIHS01 对照 rosidl
bindings/wasm/build.sh && node --test bindings/wasm/test/decode.test.mjs
```

互通测试用一次性 jazzy 容器发布 (不连机器人), 本机在无 ROS 的 venv 里装 wheel 接收:

```bash
scripts/jazzy/setup.sh                     # 起容器 rosz-jazzy (宿主网络, apt 源为 ROS 快照, 钉 rmw_zenoh_cpp 0.2.11)
scripts/jazzy/start.sh                     # 容器内起 rmw_zenohd (7447) 与测试发布端
(cd bindings/python && maturin build --release --zig --compatibility manylinux2014 --out ../../dist)   # 需在装了 maturin 与 ziglang 的 venv 里跑
scripts/jazzy/e2e.sh
docker rm -f rosz-jazzy
```

换内置 `.msg` 后用 `scripts/jazzy/golden.sh` 重新生成金样本.

## 发版

整个 workspace 统一版本号 (`Cargo.toml` 的 `workspace.package.version`, Python 与 npm 包同此). 合进 main 后手动推 `vX.Y.Z` tag, GitHub 托管 runner (`.github/workflows/release.yml`) 构建 wheel (两架构), WASM tgz, CLI 二进制并挂到 Release.
