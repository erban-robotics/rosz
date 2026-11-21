// 查看器前端. `npm run build` 出 dist/, 由 rosz-view crate 编进二进制.
// 开发: 先 `rosz view --no-open` 起后端 (默认 7450), 再 `npm run dev`, WebSocket 经代理转到后端
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const backend = process.env.ROSZ_VIEW_BACKEND ?? 'http://127.0.0.1:7450'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // rosz-wasm 的胶水按 import.meta.url 找 .wasm, 预打包后路径会变
  optimizeDeps: { exclude: ['@erban-robotics/rosz-wasm'] },
  // 本机经 127.0.0.1 取, 包大小不是瓶颈 (3D 场景单独一块, 加视图时才加载)
  build: { chunkSizeWarningLimit: 1500 },
  server: { proxy: { '/ws': { target: backend, ws: true } } },
})
