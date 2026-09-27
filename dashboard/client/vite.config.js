import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Dedicated fuzzer SSE stream — must be listed before the generic
      // '/events' rule so Vite's prefix-matching picks the right target.
      '/events/fuzzer': {
        target:       'http://localhost:4242',
        changeOrigin: true,
        // SSE requires the proxy NOT to buffer the response
        configure: (proxy) => {
          proxy.on('proxyReq', (_proxyReq, req) => {
            req.setTimeout(0);
          });
        },
      },
      '/events':    { target: 'http://localhost:4242', changeOrigin: true },
      '/api':       { target: 'http://localhost:4242', changeOrigin: true },
      '/run-tests': { target: 'http://localhost:4242', changeOrigin: true },
      '/emit':      { target: 'http://localhost:4242', changeOrigin: true },
    },
  },
});
