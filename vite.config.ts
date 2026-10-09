import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Build and dev-transform config only. The Node server in `server/` owns the HTTP listener: in
 * development (`npm run dev`) it loads Vite in middleware mode (see `server/http/dev.ts`, which sets
 * the host allowlist and HMR port), and in production it serves `dist/` itself.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  css: {
    modules: { localsConvention: 'camelCase', generateScopedName: '[name]__[local]___[hash:base64:5]' },
    preprocessorOptions: {
      // Ported CPAMC styles use these Sass variables without importing them.
      scss: { additionalData: `@use "@/styles/variables.scss" as *;` },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
