// 查看器前端. `npm run build` 出 dist/, 由 rosz-view crate 编进二进制.
// 开发: 先 `rosz view --no-open` 起后端 (默认 7450), 再 `npm run dev`, WebSocket 经代理转到后端.
// rosz-ui 直接用同仓库 packages/rosz-ui 的源码 (不经其 dist/), 改 UI 即时生效; 其依赖由 workspace 装在仓库根 node_modules.
import { fileURLToPath } from 'url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const backend = process.env.ROSZ_VIEW_BACKEND ?? 'http://127.0.0.1:7450'
const roszUi = fileURLToPath(new URL('../../../packages/rosz-ui/src', import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@erban-robotics\/rosz-ui$/, replacement: `${roszUi}/index.ts` },
      { find: /^@erban-robotics\/rosz-ui\/(.*\.css)$/, replacement: `${roszUi}/$1` },
    ],
  },
  // rosz-wasm 的胶水按 import.meta.url 找 .wasm, 预打包后路径会变
  optimizeDeps: { exclude: ['@erban-robotics/rosz-wasm'] },
  // 本机经 127.0.0.1 取, 包大小不是瓶颈 (3D 场景单独一块, 加视图时才加载)
  build: { chunkSizeWarningLimit: 1500 },
  server: { proxy: { '/ws': { target: backend, ws: true } } },
})
