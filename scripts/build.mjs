import { access, copyFile, mkdir, readFile, rm } from "node:fs/promises";
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

  // 智联使用独立 Content Script，避免站点选择器和任务状态污染猎聘闭环。
  await esbuild({
    entryPoints: ["src/content/zhilian.ts"],
    outfile: "dist/zhilian-content.js",
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
  await verifyExtensionOutput();
}

/**
 * 校验最终产物与 Manifest 的关键入口保持一致，避免构建成功但 Chrome 加载时缺少脚本。
 *
 * @returns {Promise<void>} 所有关键产物存在且版本一致时完成。
 */
async function verifyExtensionOutput() {
  const [manifestText, packageText] = await Promise.all([
    readFile("dist/manifest.json", "utf8"),
    readFile("package.json", "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const packageJson = JSON.parse(packageText);
  const requiredFiles = [
    "dist/sidepanel.html",
    `dist/${manifest.background?.service_worker ?? ""}`,
    ...((manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []).map((file) => `dist/${file}`)),
  ];
  if (manifest.version !== packageJson.version) {
    throw new Error(`Manifest 版本 ${manifest.version} 与 package.json 版本 ${packageJson.version} 不一致`);
  }
  await Promise.all(requiredFiles.map(async (file) => {
    if (file === "dist/") throw new Error("Manifest 未声明 Service Worker 入口");
    await access(file);
  }));
}

await buildExtension();
