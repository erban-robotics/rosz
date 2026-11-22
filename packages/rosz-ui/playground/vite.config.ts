// playground: 开发时看组件与验收用, 不进包. 按应用的方式用本包 (Tailwind扫源码, rosz-wasm不预打包)
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  // wasm-bindgen的胶水按import.meta.url找.wasm, 预打包后路径会变
  optimizeDeps: { exclude: ['@erban-robotics/rosz-wasm'] },
})
