import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      // 既定はローカルの api-gateway。バックエンドを起動せずに本番APIで試すときは
      //   VITE_PROXY_TARGET=https://org-ai-api-gateway.onrender.com npx vite
      // （プロキシ経由なので CORS 設定に依存しない）
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 大きい依存を独立チャンクに分割し、初期バンドルとキャッシュ効率を改善
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          motion: ['framer-motion'],
          query: ['@tanstack/react-query'],
          dnd: ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          /* ⚠️ @xyflow/react はここに書かない。manualChunks に載せると
             エントリの静的グラフ扱いになり index.html に modulepreload が付いて、
             結局全ユーザーが初回に落とすことになる（≒55KB gzip）。
             キャンバスは AgentDetailPage と AgentCtaCard から動的 import しているので、
             Rollup に任せれば必要な人だけが読む独立チャンクになる。 */
        },
      },
    },
  },
});
