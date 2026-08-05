import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 构建插件侧边栏页面，后台脚本和内容脚本由 scripts/build.mjs 分别打包。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "sidepanel.html",
    },
  },
});

