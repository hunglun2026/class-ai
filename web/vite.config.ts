import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 版本號唯一來源是 web/package.json，打包時注入成 __APP_VERSION__，畫面底部顯示
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  define: { __APP_VERSION__: JSON.stringify(version) },
});
