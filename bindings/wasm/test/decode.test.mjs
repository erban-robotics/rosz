// WASM 解码与 Python 侧 (rclpy 参照值) 一致; 先 ./build.sh, 再 node --test test/decode.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";

import { Decoder, decodeDepth, initSync } from "../pkg/rosz_wasm.js";

const repo = new URL("../../../", import.meta.url);
initSync({ module: readFileSync(new URL("bindings/wasm/pkg/rosz_wasm_bg.wasm", repo)) });
// 大整数按原文读成 BigInt, 与 WASM 输出可比
const expected = JSON.parse(readFileSync(new URL("messages/golden/expected.json", repo), "utf8"), (_, v, ctx) =>
  Number.isInteger(v) && !Number.isSafeInteger(v) ? BigInt(ctx.source) : v,
);
const sample = (name) => readFileSync(new URL(`messages/golden/rmw_zenoh_cpp/${name}.cdr`, repo));

/** TypedArray 转普通数组, BigInt 能表示为安全整数时转 number, 便于与参照值比较 */
function plain(v) {
  if (ArrayBuffer.isView(v)) return Array.from(v, plain);
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) && BigInt(Number(v)) === v ? Number(v) : v;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

test("JointState, CompressedImage, TFMessage 与 rclpy 一致", () => {
  const decoder = new Decoder();
  const cases = ["sensor_msgs.JointState", "sensor_msgs.CompressedImage", "tf2_msgs.TFMessage", "hand.PressureSensor"];
  const got = cases.map((c) => plain(decoder.decode(expected[c].type, sample(c)).tree));
  assert.deepEqual(got, cases.map((c) => expected[c].value));
});

test("64 位整数为 BigInt, 不丢精度", () => {
  const decoder = new Decoder();
  const dir = new URL("messages/test/test_msgs/msg/", repo);
  for (const file of readdirSync(dir)) decoder.addDefinition(`test_msgs/msg/${file.slice(0, -4)}`, readFileSync(new URL(file, dir), "utf8"));
  const { tree } = decoder.decode("test_msgs/msg/BasicTypes", sample("test_msgs.BasicTypes.1"));
  const want = expected["test_msgs.BasicTypes.1"].value;
  assert.deepEqual([tree.int64_value, tree.uint64_value], [BigInt(want.int64_value), BigInt(want.uint64_value)]);
});

test("深度 zstd 解码", () => {
  const [width, height] = [640, 360];
  const depth = new Uint16Array(width * height).map((_, i) => (i % width) * 3 + Math.floor(i / width) * 5 + 200);
  const header = new Uint8Array(new Uint16Array([width, height]).buffer);
  const frame = Buffer.concat([header, zstdCompressSync(new Uint8Array(depth.buffer))]);
  const decoded = decodeDepth("16UC1; zstd", frame);
  assert.deepEqual([decoded.width, decoded.height, decoded.data], [width, height, depth]);
});
