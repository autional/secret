import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // .env* 仍放在仓库根
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
  server: { port: 13122 },
  preview: { port: 13122 },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router'],
          'vendor-ui': ['antd', 'lucide-react'],
          'vendor-i18n': ['i18next', 'react-i18next'],
        },
      },
    },
  },
});
