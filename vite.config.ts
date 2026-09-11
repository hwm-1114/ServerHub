import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 端口被占用时直接失败,而不是静默改到 5174:
    // 桌面壳开发模式(package.json 的 app:dev)把 Electron 硬指向 http://localhost:5173,
    // 一旦 Vite 悄悄换端口,Electron 要么打开"别人的"应用,要么重试 60 次后报错。
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3120',
      '/ws': {
        target: 'ws://localhost:3120',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
