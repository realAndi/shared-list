import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  // Relative, so the server can mount the app anywhere; it pins the base with a
  // <base href> when it serves index.html.
  base: './',
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    // `npm run dev`: the client on 5173, the API on 8787 with BASE_PATH unset.
    proxy: {
      '/api': 'http://localhost:8787',
      '/mcp': 'http://localhost:8787',
    },
  },
});
