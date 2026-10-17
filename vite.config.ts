import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://localhost:3001';
const DATA_DIR = path.resolve('data');

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: { '/api': api, '/files': api },
    watch: {
      // data/ contiene proyectos y medios: vigilarlo es inútil y en Windows impide renombrar las carpetas
      // de los proyectos. (chokidar 4 ya no admite globs en `ignored`, por eso es una función)
      ignored: (file: string) => path.resolve(file).startsWith(DATA_DIR),
    },
  },
});
