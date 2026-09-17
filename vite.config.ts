import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: { outDir: 'dist', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:' + (process.env.API_PORT || '4318'), '/media': 'http://127.0.0.1:' + (process.env.API_PORT || '4318') } },
});
