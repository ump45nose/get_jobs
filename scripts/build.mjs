import { copyFile, mkdir, rm } from "node:fs/promises";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";

/**
 * 生成可由 Chrome 直接加载的 Manifest V3 产物。
 *
 * @returns {Promise<void>} 构建完成后返回。
 */
async function buildExtension() {
  // 先清理唯一的标准构建目录，避免旧脚本混入新版本。
  await rm("dist", { recursive: true, force: true });
  await viteBuild();
  await mkdir("dist", { recursive: true });

  // Content Script 必须是自包含脚本，避免浏览器按经典脚本加载时出现 ESM import。
  await esbuild({
    entryPoints: ["src/content/liepin.ts"],
    outfile: "dist/content.js",
    bundle: true,
    format: "iife",
    target: "chrome120",
    sourcemap: false,
  });

  // Service Worker 使用模块模式，便于保持后台代码边界清晰。
  await esbuild({
    entryPoints: ["src/background/index.ts"],
    outfile: "dist/background.js",
    bundle: true,
    format: "esm",
    target: "chrome120",
    sourcemap: false,
  });

  await copyFile("manifest.json", "dist/manifest.json");
}

await buildExtension();

