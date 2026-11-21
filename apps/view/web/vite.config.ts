// 查看器前端. `npm run build` 出 dist/, 由 rosz-view crate 编进二进制.
// 开发: 先 `rosz view --no-open` 起后端 (默认 7450), 再 `npm run dev`, WebSocket 经代理转到后端.
// 改 rosz-ui 时设 `ROSZ_UI_SRC=~/projects/rosz-ui/src`, 让 vite alias 指向本机源码 (rosz-ui README "开发期指向本地源码")
import { readFileSync } from 'fs'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const backend = process.env.ROSZ_VIEW_BACKEND ?? 'http://127.0.0.1:7450'
const roszUi = process.env.ROSZ_UI_SRC
// 源码目录不在本仓库下, 源码里的裸 import 往上找不到这里的 node_modules: rosz-ui 的依赖一律从这里解析
const roszUiDependencies = roszUi
  ? Object.keys(JSON.parse(readFileSync(`${roszUi}/../package.json`, 'utf8')).dependencies ?? {})
  : []

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: roszUi
      ? [
          { find: /^@erban-robotics\/rosz-ui$/, replacement: `${roszUi}/index.ts` },
          { find: /^@erban-robotics\/rosz-ui\/(.*\.css)$/, replacement: `${roszUi}/$1` },
        ]
      : [],
    // peer 依赖须与应用用同一份, 否则 React 出两份, 钩子失效
    dedupe: ['react', 'react-dom', 'three', '@react-three/fiber', ...roszUiDependencies],
  },
  // rosz-wasm 的胶水按 import.meta.url 找 .wasm, 预打包后路径会变
  optimizeDeps: { exclude: ['@erban-robotics/rosz-wasm'] },
  // 本机经 127.0.0.1 取, 包大小不是瓶颈 (3D 场景单独一块, 加视图时才加载)
  build: { chunkSizeWarningLimit: 1500 },
  server: { proxy: { '/ws': { target: backend, ws: true } }, fs: { allow: roszUi ? ['.', roszUi] : ['.'] } },
})
