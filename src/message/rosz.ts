/**
 * rosz核心库的浏览器解码模块 (`@erban-robotics/rosz-wasm`): 按内置`.msg`解CDR, 解压深度. 首次用到时才加载 (约310KB),
 * 全应用共用一个解码器; 适配器拿到数据源给的`.msg` (如查看器协议里的schema) 时经`addDefinition`追加.
 * wasm文件经Vite的`?url`取地址, 由应用的打包器发出.
 */
import init, { Decoder, decodeDepth } from '@erban-robotics/rosz-wasm'
import wasmUrl from '@erban-robotics/rosz-wasm/rosz_wasm_bg.wasm?url'

export type Rosz = { decoder: Decoder; decodeDepth: typeof decodeDepth }

// 解码产物: 保持字段顺序的JSON树 (数值数组为TypedArray, 64位整数为BigInt) 与按字段路径单列的TypedArray (与树里同一对象)
export type DecodedMessage = { tree: Record<string, unknown>; arrays: Record<string, ArrayBufferView> }

let loaded: Rosz | null = null
let loading: Promise<Rosz> | null = null

// 加载解码模块; 已加载即返回同一个
export function loadRosz(): Promise<Rosz> {
  loading ??= init({ module_or_path: wasmUrl }).then(
    () => {
      loaded = { decoder: new Decoder(), decodeDepth }
      return loaded
    },
    (reason) => {
      // 加载失败 (如网络抖动) 不记住, 下次用到时重试
      loading = null
      throw reason
    },
  )
  return loading
}

// 已加载的解码模块; 还没加载完为null (渲染里同步取, 没好就先等`loadRosz`)
export function loadedRosz(): Rosz | null {
  return loaded
}
