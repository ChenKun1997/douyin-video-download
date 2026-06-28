/**
 * 极简 ZIP 打包 (STORE 模式, 不压缩) —— 浏览器端, 零依赖。
 *
 * 用于图集打包下载: 把多张无水印原图打成一个 .zip。
 *
 * 为什么不压缩: 图片本身已是压缩格式 (webp/jpeg), 二次压缩收益极小,
 * 而 STORE 模式实现简单 (无需实现 deflate), 体积可控。
 *
 * 参考 ZIP File Format Specification (PKZIP), 仅实现本地文件头 + 中央目录。
 */

// DOS 时间/日期 (zip 用 16 位 MS-DOS 格式)。用当前时间即可。
function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time:
      (d.getHours() << 11) |
      (d.getMinutes() << 5) |
      (d.getSeconds() / 2) |
      0,
    date:
      (((d.getFullYear() - 1980) & 0x7f) << 9) |
      ((d.getMonth() + 1) << 5) |
      d.getDate(),
  };
}

// CRC32 表 (预计算)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string;
  data: Uint8Array;
  crc: number;
  size: number;
  localOffset: number;
}

/**
 * 打包文件列表为一个 ZIP Blob。
 * @param files [{ name, data }] 文件名和数据
 */
export async function createZip(
  files: { name: string; data: Uint8Array }[],
): Promise<Blob> {
  const dt = dosDateTime(new Date());
  const entries: Entry[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  const enc = new TextEncoder();

  // 1. 本地文件头 + 文件数据
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(localHeader.buffer);
    dv.setUint32(0, 0x04034b50, true); // 本地文件头签名
    dv.setUint16(4, 20, true); // 解压所需版本 (2.0)
    dv.setUint16(6, 0, true); // 通用标志位
    dv.setUint16(8, 0, true); // 压缩方式: 0 = STORE
    dv.setUint16(10, dt.time, true); // 修改时间
    dv.setUint16(12, dt.date, true); // 修改日期
    dv.setUint32(14, crc, true); // CRC-32
    dv.setUint32(18, f.data.length, true); // 压缩后大小
    dv.setUint32(22, f.data.length, true); // 压缩前大小
    dv.setUint16(26, nameBytes.length, true); // 文件名长度
    dv.setUint16(28, 0, true); // 额外字段长度
    localHeader.set(nameBytes, 30);

    entries.push({
      name: f.name,
      data: f.data,
      crc,
      size: f.data.length,
      localOffset: offset,
    });
    chunks.push(localHeader, f.data);
    offset += localHeader.length + f.data.length;
  }

  // 2. 中央目录
  const centralStart = offset;
  const centralChunks: Uint8Array[] = [];
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const cd = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(cd.buffer);
    dv.setUint32(0, 0x02014b50, true); // 中央文件头签名
    dv.setUint16(4, 20, true); // 版本
    dv.setUint16(6, 20, true); // 解压所需版本
    dv.setUint16(8, 0, true); // 通用标志位
    dv.setUint16(10, 0, true); // 压缩方式: STORE
    dv.setUint16(12, dt.time, true);
    dv.setUint16(14, dt.date, true);
    dv.setUint32(16, e.crc, true);
    dv.setUint32(20, e.size, true); // 压缩后
    dv.setUint32(24, e.size, true); // 压缩前
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint16(30, 0, true); // 额外字段长度
    dv.setUint16(32, 0, true); // 注释长度
    dv.setUint16(34, 0, true); // 起始盘号
    dv.setUint16(36, 0, true); // 内部属性
    dv.setUint32(38, 0, true); // 外部属性
    dv.setUint32(42, e.localOffset, true); // 本地头相对偏移
    cd.set(nameBytes, 46);
    centralChunks.push(cd);
    offset += cd.length;
  }
  const centralBytes = concat(centralChunks);

  // 3. 中央目录结束记录 (EOCD)
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(4, 0, true); // 起始盘号
  dv.setUint16(6, 0, true); // 中央目录起始盘号
  dv.setUint16(8, entries.length, true); // 本盘记录数
  dv.setUint16(10, entries.length, true); // 总记录数
  dv.setUint32(12, centralBytes.length, true); // 中央目录大小
  dv.setUint32(16, centralStart, true); // 中央目录偏移
  dv.setUint16(20, 0, true); // 注释长度

  // 拼成单个连续 Uint8Array (规避 TS BlobPart 严格类型 + 更高效)
  const all = concat([...chunks, centralBytes, eocd]);
  // 用 .slice(0) 复制到独立的 ArrayBuffer, 满足 Blob 构造的类型约束
  const owned = new Uint8Array(all.byteLength);
  owned.set(all);
  return new Blob([owned.buffer], { type: "application/zip" });
}

function concat(arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of arrays) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}
