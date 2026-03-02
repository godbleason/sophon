import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // 开发模式下通过 .env.development 中的 VITE_WS_URL 直接连接后端 WebSocket
  // 生产构建时通过 VITE_WS_URL 环境变量注入后端地址
})
