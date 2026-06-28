/**
 * 浏览器插件构建脚本。
 *
 * 用 esbuild 把 extension/src/*.ts 各自打包成单文件 (IIFE), 输出到
 * extension/dist/*.js —— MV3 content script / classic service worker
 * / popup 都不支持 ES module import, 必须打成单文件。
 *
 * 静态资源 (manifest.json, popup.html, src/rules.json, icons/) 不参与打包,
 * 加载「已解压的扩展程序」时直接以 extension/ 为根目录读取。
 *
 * 用法:
 *   node scripts/build-extension.mjs        # 构建 (开发, 不压缩)
 *   node scripts/build-extension.mjs --prod  # 压缩
 *   node scripts/build-extension.mjs --watch # 监听
 */

import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, "../extension");
const SRC = resolve(EXT, "src");
const DIST = resolve(EXT, "dist");

const watch = process.argv.includes("--watch");
const prod = process.argv.includes("--prod");

// 注意: 对象式 entryPoints 的 out 不含扩展名, esbuild 会按 format 自动补 .js
const entries = [
  { in: resolve(SRC, "background.ts"), out: "background" },
  { in: resolve(SRC, "content.ts"), out: "content" },
  { in: resolve(SRC, "popup.ts"), out: "popup" },
];

const baseOptions = {
  bundle: true,
  // IIFE: classic SW / content script / popup 都按普通脚本加载
  format: "iife",
  target: "chrome110",
  platform: "browser",
  logLevel: "info",
  sourcemap: prod ? false : "linked",
  minify: prod,
  // chrome.* 由浏览器提供, 不打包
  external: [],
  define: {
    "process.env.NODE_ENV": prod ? '"production"' : '"development"',
  },
};

async function run() {
  if (watch) {
    const ctx = await context({
      ...baseOptions,
      entryPoints: entries,
      outdir: DIST,
    });
    await ctx.watch();
    console.log("[ext] 监听中 (Ctrl+C 退出)…");
  } else {
    await build({
      ...baseOptions,
      entryPoints: entries,
      outdir: DIST,
    });
    console.log("[ext] 构建完成 → extension/dist/");
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
