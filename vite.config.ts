/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json' with { type: 'json' }

// 依赖与peer依赖一律不打进包, 由应用的打包器解析 (rosz-wasm的.wasm资源也随之由应用处理)
const external = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)]

export default defineConfig({
  plugins: [react()],
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'index' },
    sourcemap: true,
    // 不压缩: 应用打包时再压, 出问题时栈与源码对得上
    minify: false,
    emptyOutDir: false,
    rolldownOptions: {
      external: (id) => external.some((name) => id === name || id.startsWith(`${name}/`)),
    },
  },
  test: {
    environment: 'jsdom',
  },
})
