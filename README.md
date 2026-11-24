# rosz

不装 ROS 即可读取 ROS 2 (rmw_zenoh) 话题: 直连 Zenoh router, 靠 liveliness token 发现话题, 按内置 `.msg` / `.srv` (common_interfaces jazzy 全套 + audio_common_msgs + erban 自定义) 通用解码, 并解码 JPEG 与深度 (`16UC1; zstd`, `16UC1; compressedDepth`). 同一份 Rust 代码出 Rust 库, Python wheel, 浏览器 WASM 与 `rosz` 命令行; 另有共享可视化 UI 包 rosz-ui (`packages/rosz-ui`, ADP, erban-caring webapp 与查看器共用).

支持订阅, 发布, 采集写 MCAP, 服务的 server 与 client (不含 action). 传输层建在 hiroz 0.2.1 之上 (rmw_zenoh 线协议, 按类型名 + hash 的原始订阅与 ROS 图; zenoh 钉 1.9.0, 与现场 rmw_zenoh_cpp 0.2.11 / router 1.7.2 互通), 以 client 模式连 router.

## 安装

产物都挂在 [GitHub Release](https://github.com/erban-robotics/rosz/releases), 不发公共平台. 以 `v0.5.0` 为例:

- Python (x86_64 / aarch64, Python 3.8+, glibc 2.17+; ROS1 Noetic 容器的系统 python3.8 可直接装): `pip install rosz --find-links https://github.com/erban-robotics/rosz/releases/expanded_assets/v0.5.0`
- CLI 与查看器: 下载 `rosz-0.5.0-linux-x86_64` (或 `-aarch64`), musl 静态单文件, 查看器前端已嵌入, `chmod +x` 即用 (`rosz view` 即查看器)
- npm (浏览器解码): `"@erban-robotics/rosz-wasm": "https://github.com/erban-robotics/rosz/releases/download/v0.5.0/erban-robotics-rosz-wasm-0.5.0.tgz"`. npm 12 起默认 `allow-remote=none`, 拒装远程 tgz, 需在项目 `.npmrc` 写 `allow-remote=all` (或安装时加 `--allow-remote=all`)
- npm (共享 UI 包): `"@erban-robotics/rosz-ui": "https://github.com/erban-robotics/rosz/releases/download/v0.5.0/erban-robotics-rosz-ui-0.5.0.tgz"`, 同样需 `allow-remote=all`, 依赖的同版本 rosz-wasm 随之装上. 接入方式见 [packages/rosz-ui/README.md](packages/rosz-ui/README.md)
- Rust: `rosz-access = { git = "https://github.com/erban-robotics/rosz", tag = "v0.5.0" }` (只解码用 `rosz-decode`)

## router 地址

`--router` (Python 为 `connect(router=...)`) 优先, 其次环境变量 `ROSZ_ROUTER`, 都没有则报错; 不内置默认地址. 写法 `tcp/192.168.1.10:7447`, `192.168.1.10:7447` 或 `192.168.1.10` (端口默认 7447). ROS domain 取 `ROS_DOMAIN_ID` (默认 0). 环境变量 `ZENOH_CONFIG_OVERRIDE` (与 rmw_zenoh 同写法, `键=值;键=值`) 会叠加到连接配置上.

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

## 查看器

```bash
rosz view --router tcp/192.168.1.10:7447    # 或 export ROSZ_ROUTER 后直接 rosz view
```

本机起 HTTP + WebSocket 服务 (只听 127.0.0.1, 默认端口 7450, 被占用时随机; `--port` 指定), 以 Chromium 系浏览器的 `--app` 独立窗口打开: 按 xdg 默认浏览器, 再扫 PATH 找 Chrome / Chromium / Edge / Brave / Vivaldi / Deepin 浏览器, 浏览器配置用独立目录 `~/.local/share/rosz/browser-profile`; 都没有则在默认浏览器开标签页. 关窗即退出 (浏览器子进程退出, 或 WebSocket 全断超过 5 秒), Ctrl+C 同时关窗. `--no-open` 只打印地址不开窗口.

界面: 左侧话题树 (按命名空间折叠, 已订阅的显示频率, 解不了的类型变灰, transient_local 标 "静态"), 右侧面板区 (图像面板与消息树面板, 可拖动调整, "添加视图" 可加别的面板), 其右的 3D 面板与其下的曲线区. 面板要看哪些话题才订阅哪些:

- 点话题树里的话题 (或 Ctrl+K 按话题名与类型搜索, 空格分开多个词, 回车) 即加进面板, 再点移出. 图像话题进图像面板, 多路并排; 其余进消息树面板, 能解的另在曲线区列出数值字段, 点字段画最近 10 秒的曲线. 加了哪些, 面板的拖动排布与曲线所选字段都存在浏览器本地 (固定端口 7450 同源才保留), 下次打开仍在; 首次打开自动挑一路彩色, 一路深度. 关掉了图像或消息树面板后再点话题, 面板在右侧重新打开; "恢复默认布局" 只复位排布, 不清已加的话题
- 图像: `CompressedImage` 的 JPEG / PNG 彩色, `16UC1; zstd` 与 `16UC1; compressedDepth` 深度 (伪彩色, 悬停显示该点毫米值); 原始 `Image` 的 `rgb8` `bgr8` `rgba8` `bgra8` `mono8` 彩色与 `16UC1` `mono16` `32FC1` 深度. 不支持的格式 (如 zstd_image_transport 的 `zstd`) 与空数据整路变灰, 面板上写明原因
- 无定义的类型变灰, 消息树里只显示名称, 类型与原因
- 3D: `TFMessage` (`/tf` `/tf_static` 等) 与 `PointCloud2` 话题点进 3D 面板 (没选过时默认全部 TF 话题). 面板为 rosz-ui 的 3D 场景 (与 ADP 回放同一套): 坐标系画成坐标轴, 名字与指向父坐标系的连线; 点云按其 frame 经 TF 树换算后画点 (有 `rgb` 字段时带色, 超过 20 万点等间隔抽取). 一切换算到 "基座标系" (默认最大那棵 TF 树的根, 可选); TF 取各边最新的一条, 不按点云时间戳插值. 只要 3D 面板开着就订阅全部 TF 话题 (点云换算要用). 视角只在打开或换了话题, 基座标系时取景一次, 数据更新不复位 ("重新取景" 可手动再取). 浏览器拿不到 WebGL 时只在 3D 面板内提示. 不显示机器人模型
- transient_local 话题 (如 `/tf_static`) 订阅时先取各发布端缓存的历史 (rmw_zenoh 的 AdvancedPublisher 缓存, 深度为发布端 QoS 的 history depth), 所以晚于发布打开查看器也看得到; 同一话题的发布端 durability 不一时, 有一个 transient_local 即按 transient_local 订阅. 从未发布过的 transient_local 话题 (如没有过目标的 action `_action/status`) 自然取不到

后端与前端之间为 `foxglove.websocket.v1` 的子集 (见 `apps/view/src/protocol.rs`): 后端只转原始 CDR 不解码, 数据帧带后端 PC 时钟的接收时间, 前端以它为接收时刻; 解码与渲染在前端 (共享 UI 包 rosz-ui + rosz-wasm).

背压 (前端处理不过来时, 见 `apps/view/src/outbox.rs`): 每个订阅一个发送队列. `CompressedImage` `Image` `PointCloud2` `CompressedVideo` 每路只留最新一条, 连接待发字节低于 4 MB 才入队 (降帧, 不通知); 其余话题各留约 1 秒, 满了丢最旧的并发 "已丢 N 条" (`status` 帧附 `subscriptionId` 与 `dropped`), 前端记一次不连续并在顶上提示累计条数. 先发小消息再发大消息, 图像不挡在小消息前面.

## 采集 (MCAP)

按话题清单把收到的消息原样写成 MCAP (ros2 profile), Rust, Python, CLI 三种用法:

```bash
rosz collect /joint_states /tf /tf_static --out ep.mcap --seconds 10 --compression zstd   # 不给 --seconds 则到 Ctrl-C / SIGTERM
```

```python
collector = rz.collect("ep.mcap", ["/joint_states", "/head/color/compressed"], compression=None, chunk_size=768 * 1024)
collector.stats()        # 运行中随时读
summary = collector.stop()   # 写完队列并封口, 返回最终统计; 也可 with rz.collect(...) as c:
```

```rust
let collector = session.collect("ep.mcap", &["/joint_states"], rosz_access::CollectOptions::default()).await?;
let stats = collector.stop().await?;
```

- 发现驱动订阅: 清单里开录时还没有发布端的话题 (含发布进程中途重启) 一上线即订上; transient_local 话题先取发布端缓存的历史 (至多 1000 条); 已按 volatile 订上的话题后来出现 transient_local 发布端时改用 transient_local 重订补取其历史, 按 (发布端 gid, 序号) 去重. 收不到的话题不报错, 只是不在统计里
- 不丢: zenoh 回调只入无界队列, 独立写盘线程写 MCAP; `stop` 撤掉订阅后写完队列再封口
- 每话题一个 channel, 消息编码 `cdr`; `log_time` = 本机接收时刻, `publish_time` = attachment 源时间戳, `sequence` = 发布端序号低 32 位 (无 attachment 时为接收时刻与 0). schema 为 `ros2msg` 文本, 由 rosz 注册表生成, 与 rosbags `generate_msgdef` (erban-caring 原录制器) 逐字一致; 注册表没有的类型 schema 留空照写
- chunk 压缩 `none` (默认) / `zstd` / `lz4`, chunk 大小默认 768 KiB
- 统计 (Python dict, CLI JSON 同结构): `topics` 每话题 `type`, `received`, `written`, `gaps` (按发布端 gid 各自的序号缺口), `publisher_restarts`, `last_receive_time_ns`, `last_header_stamp_ns` (最近一条的 Header.stamp), `latency_ns` (`p50` / `p95` / `max`, 接收减源时间戳, 只算最近 1000 条的滑动窗口, 最近秩分位); 另有 `written`, `queue_depth`, `last_write_time_ns`, `errors`
- 不内置 "就绪" 与 "追到停止时刻": 由调用方看统计自己判 (如等各话题 `received > 0`, 等 `last_header_stamp_ns` 追过停止时刻再 `stop`)

订阅到的 `Message` 带发布端序号 `sequence` (attachment, 每个发布端从 1 起).

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

发布 (仿 rclpy 命名, 类型从内置与 `connect(msg_dirs=[...])` 追加的 `.msg` 目录运行时解析, 目录按 `<包>/msg/<类型>.msg` 递归查找, 如 erban_interfaces):

```python
rz = rosz.connect(msg_dirs=["/opt/erban_interfaces"])
pub = rz.create_publisher("sensor_msgs/msg/JointState", "/joint_states")      # qos_profile 默认 10: reliable, volatile, keep_last(10)
pub.publish({"header": {"stamp": {"sec": 0, "nanosec": 0}, "frame_id": "base"},
             "name": ["j1"], "position": np.array([0.1]), "velocity": [], "effort": []})
static = rz.create_publisher("tf2_msgs/msg/TFMessage", "/tf_static",
                             rosz.QoSProfile(depth=1, reliability="reliable", durability="transient_local"))
pub.get_subscription_count(); pub.destroy()                                 # 或 with rz.create_publisher(...) as pub:
```

消息为 dict, 须给全全部字段 (不取默认值); 嵌套消息为 dict, 数组可为 list/tuple, numpy 数组 (多维按 C 序展平) 或 bytes. 整数按字段类型查范围, 浮点字段也收整数. 字段缺失, 多出, 类型不符, 越界, 定长数组长度不符, 有界序列/字符串超界都抛 `rosz.EncodeError` (ValueError 子类, `path` 为字段路径如 `header.stamp.sec`), 什么也不发; 类型未知抛 `LookupError`. `QoSProfile` 的 reliability 取 `reliable`/`best_effort`, durability 取 `volatile`/`transient_local`. 发布端声明 liveliness token, 每条带 attachment (序号, 源时间戳), 与 rclpy 发布端一致.

### 服务

仿 rclpy 命名, 无 executor/spin. 类型从内置与 `msg_dirs` 追加目录的 `<包>/srv/<类型>.srv` 运行时解析 (服务 type hash 由 `.srv` 算出, 同 rosidl). 请求与应答都是 dict, 校验同发布.

```python
rz = rosz.connect(msg_dirs=["/opt/erban_interfaces"])

def get_preset(request, response):           # response 为零值应答 dict (数值 0, 字符串空, 嵌套逐字段零值), 改了返回即可
    response["preset_yaml"] = load(request["name"])
    return response                          # 也可返回新 dict; 须给全字段

srv = rz.create_service("erban_interfaces/srv/GetPreset", "/manip/presets/get", get_preset)   # workers=1
srv.destroy()                                # 或 with rz.create_service(...) as srv: ; 撤销并等手上的请求处理完

cli = rz.create_client("std_srvs/srv/SetBool", "/robot/enable")
cli.wait_for_service(timeout_sec=5.0)        # 只看服务端 liveliness token; None 为一直等 (同 rclpy); 超时为 False
cli.call({"data": True}, timeout_sec=2.0)    # 应答 dict; 超时或没有服务端为 None
```

- callback 只在服务自有的工作线程里跑 (默认 1 个, `workers=N` 时最多 N 个并发), 永不在 zenoh 接收线程; 进程不必 spin, 主线程照常干别的. 请求在工作线程忙时排队, 不丢.
- 每个请求必回应答 (带回请求序号), 不用 `reply_err`: rmw_zenoh 把它当作没有应答, rclpy client 会一直等. 所以 callback 出错时 rosz 不学 rclpy (rclpy 回调抛异常时 executor 退出, 对端永远等不到应答), 而是记日志 (`logging.getLogger("rosz")`, error, 含 traceback) 并回 "失败应答":
  - 应答类型顶层有回执字段 (类型为 `*/msg/Receipt`, 有 `uint8 code`, `string message`, `string detail_json`, 即 `erban_interfaces/msg/Receipt` 约定) 时, 以零值应答为底填回执: callback 抛异常或返回值不合定义为 `code=5` (INTERNAL_ERROR), 请求解不了为 `code=1` (INVALID_REQUEST); `message` 为错误概要, `detail_json` 为 JSON 对象 `{"error": ..., "traceback": ...}` (返回值不合定义时为 `"path"`, 出错字段路径). 其余字段为零值.
  - 没有回执字段时回零值应答 (如 Trigger 为 `success=False, message=""`); 调用方区分不了成功与失败, 所以可能失败的服务请用 Receipt 回执 (`code == 0` 即成功, 不设 `bool success`).
  - 业务失败 (请求合法但执行没成功) 由 callback 自己按约定填回执码返回, 不要抛异常.
- client: 请求不合定义抛 `rosz.EncodeError`, 什么也不发. `timeout_sec=None` 同 rclpy 不设本地超时, 但查询本身最多 600 s (同 rmw_zenoh 默认 `queries_default_timeout`), 到时返回 None, 不会永远挂住; 服务不存在时查询立即结束, 返回 None. 等待中释放 GIL, 可 Ctrl-C. `service_is_ready()` 即时查.
- 服务名为相对名时补成 `/名` (根命名空间). 服务端与客户端的 token 都挂在节点 `rosz` 下.

按彩色像素查深度只支持深度已对齐到彩色 (视场相同, 分辨率成同一整数倍, 最近邻换算); 未对齐需内外参投影, 不做. 预期内失败用返回值; 只有程序错误 (话题不存在抛 `rosz.TopicNotFound`, 带 `candidates`) 与连接失败 (`ConnectionError`) 抛异常.

## Rust

```rust
let session = rosz_access::connect(Some("tcp/192.168.1.10:7447")).await?;
if let Some(msg) = session.latest("/joint_states", std::time::Duration::from_secs(2)).await? {
    println!("{:?}", msg.value()?.get("position"));
}
```

发布: `session.create_publisher("std_msgs/msg/String", "/chatter", QosProfile::default()).await?`, 再 `publisher.publish(&value)?` (`Value` 值树, 校验不过为 `Error::Encode`).

服务: `session.create_service("std_srvs/srv/SetBool", "/enable", ServiceOptions::default(), |request, response| Ok(response)).await?` (handler 为 `Fn(请求, 零值应答) -> Result<应答, HandlerError>`, 跑在服务自有的工作线程; 失败语义同 Python, 失败经 `ServiceOptions::on_failure`, 默认 `tracing` 记 warn); `session.create_client(类型, 名).await?` 后 `client.wait_for_service(Some(超时)).await` (bool), `client.call(&value, Some(超时)).await?` (`Ok(None)` 为超时或无服务端, 应答解不了为 `Error::Decode`).

`rosz_decode::Registry` 可单独用: `Registry::builtin()` 含全部内置类型, `add_dir` 运行时追加 (`.msg` 与 `.srv`; `包/srv/X` 登记为 `X_Request`, `X_Response` 与只用于算 hash 的 `X_Event`, `X`), `zero_value(类型)` 为零值, `decode(类型, CDR)` 出保持字段顺序的值树 (`uint8[]` 零拷贝), `encode(类型, &值树)` 反向编码为 CDR (按定义收窄与校验, 宽松输入: 整数 `I64`/`U64`, 浮点 `F64`, 数组 `List` 或数值数组), `rihs01(类型)` 由定义算 type hash.

## 浏览器 (WASM)

见 [bindings/wasm/README.md](bindings/wasm/README.md). 解码, zstd, 16 位 PNG 同一个模块, 约 320 KB (gzip 130 KB; `bindings/wasm/build.sh` 未装 wasm-opt 时实测).

## 仓库布局

| 目录 | 内容 |
|---|---|
| `crates/decode` | `rosz-decode`: `.msg` 注册表, XCDR1 解码与编码, RIHS01, MCAP schema 文本, 媒体解码 (JPEG 在 `jpeg` 开关后) |
| `crates/access` | `rosz-access`: rmw_zenoh 话题发现, 订阅, 发布, 采集 (MCAP) 与服务 |
| `apps/cli` | `rosz` 命令行 |
| `apps/view` | `rosz-view`: 查看器后端 (`rosz view`); `web/` 为前端 (Vite + React + rosz-ui 源码), 构建产物编进二进制 |
| `bindings/python` | PyO3 wheel |
| `bindings/wasm` | wasm-bindgen 模块与 npm 包 |
| `packages/rosz-ui` | 共享可视化 UI 包 `@erban-robotics/rosz-ui` (原 erban-robotics/rosz-ui 仓库, 带历史并入), 见 [其 README](packages/rosz-ui/README.md) |
| `messages` | 内置 `.msg` / `.srv` 与解码金样本, 见 [messages/README.md](messages/README.md) |
| `scripts/jazzy` | 一次性 jazzy 容器 (rmw_zenoh_cpp 0.2.11): 生成金样本, 互通测试的发布端, rclpy 订阅端 (`listen.py`) 与服务对端 (`service.py`), 测试用 erban_interfaces 现编 (`erban_interfaces.sh`) |
| `tests/e2e` | 互通测试 (pytest) |

## 开发与测试

```bash
cargo test -p rosz-decode                  # 金样本回归: 逐字段对照 rclpy, 再编码与 rclpy 逐字节对照, 188 个消息与 46 个服务 (各含请求/应答/事件) RIHS01 对照 rosidl
bindings/wasm/build.sh && node --test bindings/wasm/test/decode.test.mjs
npm install && npm run check -w @erban-robotics/rosz-ui    # rosz-ui: tsc + eslint + vitest
```

前端 (WASM 包, rosz-ui, 查看器前端) 为仓库根的一个 npm workspace, 依赖装在根 `node_modules`, 锁文件为根 `package-lock.json`. WASM 包的 workspace 成员是 `bindings/wasm/pkg` (由 `build.sh` 生成), 所以 `npm install` 前须先 `bindings/wasm/build.sh`. rosz-ui 依赖本地 WASM 包, 查看器前端经 vite alias 与 tsconfig `paths` 直接用 rosz-ui 源码, 改解码或 UI 不用先发版.

互通测试用一次性 jazzy 容器发布 (不连机器人), 本机在无 ROS 的 venv 里装 wheel 接收:

```bash
scripts/jazzy/setup.sh                     # 起容器 rosz-jazzy (宿主网络, apt 源为 ROS 快照, 钉 rmw_zenoh_cpp 0.2.11)
scripts/jazzy/start.sh                     # 容器内起 rmw_zenohd (7447) 与测试发布端
(cd bindings/python && maturin build --release --zig --compatibility manylinux2014 --out ../../dist)   # 需在装了 maturin 与 ziglang 的 venv 里跑
scripts/jazzy/e2e.sh
docker rm -f rosz-jazzy
```

换内置 `.msg` 后用 `scripts/jazzy/golden.sh` 重新生成金样本. 采集测试的额外发布端 (晚上线, transient_local, 发布进程重启) 为 `scripts/jazzy/publish_collect.py`, 由测试经 `docker exec` 拉起; 服务测试的 rclpy 对端为 `scripts/jazzy/service.py`, 带 Receipt 回执的 erban 服务 (`messages/test/erban_interfaces`, 取自 erban-caring IDL 草案) 由测试调 `scripts/jazzy/erban_interfaces.sh` 在容器里现编 (几秒, 不进 setup.sh); schema 对照 `tests/e2e/message_schema.json` 用 `tests/e2e/gen_message_schema.py` 从 erban-caring 录制器重新生成 (用法见其开头).

查看器前端须先构建, 产物 (`apps/view/web/dist`) 在编译 `rosz` 时编进二进制; 未构建时页面只提示先构建. 查看器协议不写自动化测试, 靠手动验收 (可用上面的 jazzy 容器发布):

```bash
bindings/wasm/build.sh && npm install && npm run build -w rosz-view-web && cargo build --release -p rosz-cli
target/release/rosz view --router tcp/127.0.0.1:7447
# 3D 面板: 容器里另起 scripts/jazzy/publish_3d.py (static_transform_publisher, 动态 /tf, 两路点云; 用法见其开头), 过一会儿再开查看器
# 改前端时: 一边 rosz view --no-open 起后端, 一边在 apps/view/web 里 npm run dev (WebSocket 经代理转到 7450)
# 查看器前端直接用 packages/rosz-ui 的源码, 改 rosz-ui 即时生效
```

## 发版

整个仓库统一版本号: `Cargo.toml` 的 `workspace.package.version` 为准, Python 包同此, `bindings/wasm/package.json` 与 `packages/rosz-ui/package.json` 的 `version` 须手动改成同一个 (发版时检查; 打包时也从 `Cargo.toml` 取), 改后 `cargo check` 与 `bindings/wasm/build.sh && npm install` 更新两个锁文件. 合进 main 后手动推 `vX.Y.Z` tag, GitHub 托管 runner (`.github/workflows/release.yml`) 构建 wheel (两架构), WASM tgz, rosz-ui tgz (`packages/rosz-ui/pack.sh`, 其对 rosz-wasm 的依赖改写为同版本 Release 地址), 查看器前端与 CLI 二进制并挂到 Release. CLI 二进制编进同一任务构建的查看器前端, 构建后检查前端已嵌入, 所以 Release 上的 `rosz` 即带界面的查看器单文件.
