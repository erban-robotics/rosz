// 深度一帧 zstd 解码耗时 (含拷出到 JS). 帧为 640x360, 平滑面加噪声与无效点, 压缩比接近现场 (约 3.6x)
import { readFileSync } from "node:fs";
import { zstdCompressSync, constants } from "node:zlib";

import { decodeDepth, initSync } from "../pkg/rosz_wasm.js";

initSync({ module: readFileSync(new URL("../pkg/rosz_wasm_bg.wasm", import.meta.url)) });
const [width, height] = [640, 360];
let seed = 1;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const depth = new Uint16Array(width * height).map((_, i) => {
  const [x, y] = [i % width, Math.floor(i / width)];
  return random() < 0.03 ? 0 : 1500 + (x >> 2) + (y >> 2) + (random() < 0.3 ? 1 : 0);
});
const header = new Uint8Array(new Uint16Array([width, height]).buffer);
const compressed = zstdCompressSync(new Uint8Array(depth.buffer), { params: { [constants.ZSTD_c_compressionLevel]: 1 } });
const frame = Buffer.concat([header, compressed]);
for (let i = 0; i < 50; i++) decodeDepth("16UC1; zstd", frame);
const n = 500;
const start = performance.now();
for (let i = 0; i < n; i++) decodeDepth("16UC1; zstd", frame).data;
const ms = (performance.now() - start) / n;
console.log(`帧 ${(frame.length / 1024).toFixed(1)} KB -> ${(depth.byteLength / 1024).toFixed(1)} KB, 每帧 ${ms.toFixed(3)} ms`);
