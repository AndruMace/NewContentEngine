import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

const target = `http://127.0.0.1:${process.env.SIM_SERVER_PORT ?? 5174}`;

// When the API server restarts mid-response, drop the browser's connection too. Otherwise a live
// (SSE) stream hangs open with no error, and the page never learns to reconnect.
const api: ProxyOptions = {
  target,
  configure: (proxy) =>
    proxy.on('proxyRes', (proxyRes, _req, res) => {
      proxyRes.on('close', () => {
        if (!res.writableEnded) res.destroy();
      });
    }),
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': api, '/files': api, '/ambient-assets': api } },
});
