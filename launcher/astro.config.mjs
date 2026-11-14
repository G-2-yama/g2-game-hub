import { defineConfig } from 'astro/config';

// ランチャー（Tauri）の画面。1ページのみで、画面の切り替えは src/app.ts が行う。
export default defineConfig({
  output: 'static',
});
