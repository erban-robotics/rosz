# rosz

不装 ROS 即可读取 ROS 2 (rmw_zenoh) 话题: 直连 Zenoh router, 靠 liveliness token 发现话题, 按内置 `.msg` (common_interfaces jazzy 全套 + erban 自定义) 通用解码, 并解码 JPEG 与深度 (`16UC1; zstd`, `16UC1; compressedDepth`). 同一份 Rust 代码出 Rust 库, Python wheel, 浏览器 WASM 与 `rosz` 命令行; 另有共享可视化 UI 包 rosz-ui (`packages/rosz-ui`, ADP, erban-caring webapp 与查看器共用).

第一版只订阅, 不发布不调服务. 传输层建在 hiroz 0.2.1 之上 (rmw_zenoh 线协议, 按类型名 + hash 的原始订阅与 ROS 图; zenoh 钉 1.9.0, 与现场 rmw_zenoh_cpp 0.2.11 / router 1.7.2 互通), 以 client 模式连 router.

## 安装

产物都挂在 [GitHub Release](https://github.com/erban-robotics/rosz/releases), 不发公共平台. 以 `v0.4.0` 为例:

- Python (x86_64 / aarch64, Python 3.10+): `pip install rosz --find-links https://github.com/erban-robotics/rosz/releases/expanded_assets/v0.4.0`
- CLI 与查看器: 下载 `rosz-0.4.0-linux-x86_64` (或 `-aarch64`), musl 静态单文件, 查看器前端已嵌入, `chmod +x` 即用 (`rosz view` 即查看器)
- npm (浏览器解码): `"@erban-robotics/rosz-wasm": "https://github.com/erban-robotics/rosz/releases/download/v0.4.0/erban-robotics-rosz-wasm-0.4.0.tgz"`. npm 12 起默认 `allow-remote=none`, 拒装远程 tgz, 需在项目 `.npmrc` 写 `allow-remote=all` (或安装时加 `--allow-remote=all`)
- npm (共享 UI 包): `"@erban-robotics/rosz-ui": "https://github.com/erban-robotics/rosz/releases/download/v0.4.0/erban-robotics-rosz-ui-0.4.0.tgz"`, 同样需 `allow-remote=all`, 依赖的同版本 rosz-wasm 随之装上. 接入方式见 [packages/rosz-ui/README.md](packages/rosz-ui/README.md)
- Rust: `rosz-access = { git = "https://github.com/erban-robotics/rosz", tag = "v0.4.0" }` (只解码用 `rosz-decode`)

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
| `apps/view` | `rosz-view`: 查看器后端 (`rosz view`); `web/` 为前端 (Vite + React + rosz-ui 源码), 构建产物编进二进制 |
| `bindings/python` | PyO3 wheel |
| `bindings/wasm` | wasm-bindgen 模块与 npm 包 |
| `packages/rosz-ui` | 共享可视化 UI 包 `@erban-robotics/rosz-ui` (原 erban-robotics/rosz-ui 仓库, 带历史并入), 见 [其 README](packages/rosz-ui/README.md) |
| `messages` | 内置 `.msg` 与解码金样本, 见 [messages/README.md](messages/README.md) |
| `scripts/jazzy` | 一次性 jazzy 容器 (rmw_zenoh_cpp 0.2.11): 生成金样本, 互通测试的发布端 |
| `tests/e2e` | 互通测试 (pytest) |

## 开发与测试

```bash
cargo test -p rosz-decode                  # 金样本回归: 逐字段对照 rclpy, 188 个类型 RIHS01 对照 rosidl
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

换内置 `.msg` 后用 `scripts/jazzy/golden.sh` 重新生成金样本.

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
