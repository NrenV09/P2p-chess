import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import {defineConfig, loadEnv, Plugin} from 'vite';
import { viteSingleFile } from "vite-plugin-singlefile";

function serveStandalonePlugin(): Plugin {
  return {
    name: 'serve-standalone-html',
    configureServer(server) {
      server.middlewares.use('/download/chess-game.html', (_req, res) => {
        const distFile = path.resolve(__dirname, 'dist/index.html');
        if (fs.existsSync(distFile)) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Content-Disposition', 'attachment; filename="chess-game.html"');
          res.end(fs.readFileSync(distFile));
        } else {
          res.statusCode = 404;
          res.end('Standalone build not found');
        }
      });
    },
  };
}

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    base: './',
    plugins: [react(), tailwindcss(), viteSingleFile(), serveStandalonePlugin()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
