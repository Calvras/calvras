import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  root,
  configFile: false,
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.join(root, 'src') },
  },
  build: {
    outDir: 'electron/prompt-input/dist',
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: {
      input: path.join(root, 'electron/prompt-input/entry.tsx'),
      treeshake: false,
      output: {
        format: 'iife',
        entryFileNames: 'prompt-input.js',
        assetFileNames: 'prompt-input.[ext]',
      },
    },
  },
  logLevel: 'warn',
});

console.log('Built electron/prompt-input/dist/prompt-input.js + prompt-input.css');