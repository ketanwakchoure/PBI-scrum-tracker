import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // On GitHub Pages the app is served from /<repo>/ — set VITE_BASE there.
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  server: {
    port: 4601,
    proxy: {
      '/api': 'http://localhost:4600'
    }
  }
});
