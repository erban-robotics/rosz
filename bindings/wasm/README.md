# @erban-robotics/rosz-wasm

rosz 的浏览器解码模块 (wasm-bindgen `--target web`): 按内置 `.msg` (common_interfaces jazzy + audio_common_msgs + erban 自定义) 解码 ROS 2 CDR, 算 RIHS01, 解压深度.

```js
import init, { Decoder, decodeDepth } from "@erban-robotics/rosz-wasm";

await init(); // Node 下: initSync({ module: fs.readFileSync(new URL("rosz_wasm_bg.wasm", import.meta.resolve("@erban-robotics/rosz-wasm"))) })
const decoder = new Decoder();
const { tree, arrays } = decoder.decode("sensor_msgs/msg/JointState", cdrBytes);
// tree.position 为 Float64Array, arrays["position"] 为同一个对象; 64 位整数为 BigInt
const depth = decodeDepth("16UC1; zstd", compressedImage.data); // { width, height, data: Uint16Array (毫米) }
```

- `decoder.addDefinition(name, text)`: 追加定义 (`包/msg/类型` 按 `.msg`, `包/srv/类型` 按 `.srv` 解析, 后者登记 `_Request` / `_Response`); `decoder.rihs01(name)`; `decoder.undecodableReason(name, hash)`; `decoder.sampleTime(name, cdr)` (Header.stamp, 纳秒 BigInt)
- TypedArray 均拷出 WASM 内存, 内存增长后仍有效
