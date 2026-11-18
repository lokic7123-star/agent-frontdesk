// The page: src/client/index.html is the entry; `vite build` writes dist/public, which the server
// serves. In development (npm run dev) Vite serves the page with HMR and hands /api and /uploads
// to the server that `tsx watch` runs next to it.
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

const port = Number(process.env.PORT || 4100);
const api = Number(process.env.API_PORT || port + 1);
const backend = { target: `http://127.0.0.1:${api}`, ws: false };

export default defineConfig({
  root: 'src/client',
  publicDir: 'public',
  plugins: [{ name: 'clean-dist-server', apply: 'build', buildStart() {
    for (const dir of ['dist/server', 'dist/shared']) {
      fs.rmSync(path.resolve(import.meta.dirname, dir), { recursive: true, force: true });
    }
  } }],
  build: { outDir: '../../dist/public', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 4096 },
  server: { host: process.env.HOST || '127.0.0.1', port, strictPort: true, proxy: { '/api': backend, '/uploads': backend } },
  preview: { port },
});
