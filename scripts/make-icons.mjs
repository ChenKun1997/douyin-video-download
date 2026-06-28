/**
 * 生成插件占位图标 (纯色圆角方块 + 下载箭头, 无外部依赖)。
 *
 * 直接手写 PNG 字节流 (RGBA, 无压缩需 zlib), 输出 16/48/128 三个尺寸。
 * 复用 Node 内置 zlib 做 deflate。
 *
 * 用法: node scripts/make-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS = resolve(__dirname, "../extension/icons");

// 抖音红
const BG = [254, 44, 85];
const FG = [255, 255, 255];

/** 在像素缓冲里画填充圆角方块底 + 简易下载箭头。 */
function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.22; // 圆角半径
  const cx = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 圆角判定: 距最近边角
      const inX = x >= r && x <= size - 1 - r;
      const inY = y >= r && y <= size - 1 - r;
      let corner = true;
      if (inX || inY) corner = false;
      if (corner) {
        // 四个角的圆心
        const ccx = x < size / 2 ? r : size - 1 - r;
        const ccy = y < size / 2 ? r : size - 1 - r;
        const dx = x - ccx;
        const dy = y - ccy;
        if (dx * dx + dy * dy > r * r) {
          buf[i + 3] = 0; // 透明
          continue;
        }
      }
      // 默认底色
      let [R, G, B] = BG;

      // 下载箭头: 一根竖线 + 两条斜线 + 底部托盘
      const u = size / 48; // 以 48 为基准单位
      // 竖线 (中段)
      const stemHalf = 2.2 * u;
      const stemTop = 13 * u;
      const stemBot = 30 * u;
      if (
        Math.abs(x - cx) <= stemHalf &&
        y >= stemTop &&
        y <= stemBot
      ) {
        [R, G, B] = FG;
      }
      // 两条斜线组成箭头头部 (V 形)
      const armTop = 22 * u;
      const armBot = 32 * u;
      if (y >= armTop && y <= armBot) {
        const t = (y - armTop) / (armBot - armTop); // 0..1
        const half = (6 + t * 9) * u; // 向下张开
        if (Math.abs(Math.abs(x - cx) - half) <= 2.2 * u) {
          [R, G, B] = FG;
        }
      }
      // 底部托盘 (短横线)
      const trayY = 34 * u;
      const trayH = 2.4 * u;
      const trayHalf = 13 * u;
      if (y >= trayY && y <= trayY + trayH && Math.abs(x - cx) <= trayHalf) {
        [R, G, B] = FG;
      }

      buf[i] = R;
      buf[i + 1] = G;
      buf[i + 2] = B;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

/** 组装一张 RGBA PNG (带 IHDR + IDAT + IEND)。 */
function encodePng(rgba, size) {
  // 加过滤字节 (每行首字节 0 = None)
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = deflateSync(raw);

  const u32 = (n) =>
    Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

  const chunk = (type, data) => {
    const t = Buffer.from(type, "ascii");
    const body = Buffer.concat([t, data]);
    // CRC32
    let c = ~0;
    for (const b of body) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    const crc = u32(~c >>> 0);
    return Buffer.concat([u32(data.length), body, crc]);
  };

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.concat([
    u32(size),
    u32(size),
    Buffer.from([8, 6, 0, 0, 0]), // 8-bit, color type 6 (RGBA)
  ]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(ICONS, { recursive: true });
for (const size of [16, 48, 128]) {
  const rgba = draw(size);
  const png = encodePng(rgba, size);
  const p = resolve(ICONS, `icon${size}.png`);
  writeFileSync(p, png);
  console.log("wrote", p, png.length, "bytes");
}
