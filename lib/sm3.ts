/**
 * SM3 密码杂凑算法 (GB/T 32905-2016) —— 纯 TypeScript 实现。
 *
 * 用于 a_bogus 签名 (lib/abogus.ts)。抖音 a_bogus 算法对 params / body / ua
 * 取 SM3 摘要, 因此必须和 Python gmssl.sm3 逐字节一致。
 *
 * 参考实现: gmssl.sm3.sm3_hash (按字节 list 计算, 返回 32 字节 hex)。
 * 这里导出 sm3Bytes(bytes)->Uint8Array(32), 与 gmssl 的 bytes_to_list+sm3_hash 等价。
 *
 * 验证 (已对 sm-crypto 逐 case 比对一致, 含 "abc" / 空 / 跨块 / 1MB):
 *   "abc" -> 66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0
 *
 * 注意: 本文件刻意与上游字节序/循环结构保持一致, 便于在抖音变更算法时
 *       对照 Python 移植版定位差异。
 */

// ---------------- 32 位字辅助 (对应 gmssl.func.rotl / *_uint32_be) ----------------

/** 循环左移 (32 位)。 */
function rotl(x: number, n: number): number {
  // 与 Python: ((x << n) & 0xffffffff) | ((x >> (32 - n)) & 0xffffffff) 等价
  return (((x << n) & 0xffffffff) | (x >>> (32 - n))) >>> 0;
}

/** 大端取 4 字节为一个 uint32。 */
function getUint32Be(keyData: number[]): number {
  return (
    ((keyData[0] << 24) |
      (keyData[1] << 16) |
      (keyData[2] << 8) |
      keyData[3]) >>>
    0
  );
}

/** uint32 拆成大端 4 字节。 */
function putUint32Be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** 异或两个等长字节数组。 */
function xorBytes(a: number[], b: number[]): number[] {
  return a.map((x, i) => x ^ b[i]);
}

// ---------------- SM3 常量与函数 ----------------

const IV = [
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa,
  0xe38dee4d, 0xb0fb0e4e,
];

/** Tj: j<16 用 0x79cc4519, 否则 0x7a879d8a。 */
function tj(j: number): number {
  return j < 16 ? 0x79cc4519 : 0x7a879d8a;
}

/** FFj。 */
function ff(j: number, x: number, y: number, z: number): number {
  return j < 16 ? (x ^ y ^ z) : ((x & y) | (x & z) | (y & z));
}

/** GGj。 */
function gg(j: number, x: number, y: number, z: number): number {
  return j < 16 ? (x ^ y ^ z) : ((x & y) | (~x & z));
}

/** P0。 */
function p0(x: number): number {
  return (x ^ rotl(x, 9) ^ rotl(x, 17));
}

/** P1。 */
function p1(x: number): number {
  return (x ^ rotl(x, 15) ^ rotl(x, 23));
}

/** 消息扩展 + 压缩 (单 512-bit 块)。 */
function cf(v: number[], b: number[]): number[] {
  const w = new Array<number>(68).fill(0);
  const wp = new Array<number>(64).fill(0);
  for (let i = 0; i < 16; i++) {
    w[i] = getUint32Be(b.slice(i * 4, i * 4 + 4));
  }
  for (let j = 16; j < 68; j++) {
    w[j] = (p1(w[j - 16] ^ w[j - 9] ^ rotl(w[j - 3], 15)) ^
      rotl(w[j - 13], 7) ^
      w[j - 6]) >>>
      0;
  }
  for (let j = 0; j < 64; j++) {
    wp[j] = (w[j] ^ w[j + 4]) >>> 0;
  }

  let a = v[0],
    b1 = v[1],
    c = v[2],
    d = v[3],
    e = v[4],
    f = v[5],
    g = v[6],
    h = v[7];

  for (let j = 0; j < 64; j++) {
    const ss1 = rotl(
      (rotl(a, 12) + e + rotl(tj(j), j % 32)) >>> 0,
      7,
    );
    const ss2 = (ss1 ^ rotl(a, 12)) >>> 0;
    const tt1 = (ff(j, a, b1, c) + d + ss2 + wp[j]) >>> 0;
    const tt2 = (gg(j, e, f, g) + h + ss1 + w[j]) >>> 0;
    d = c;
    c = rotl(b1, 9);
    b1 = a;
    a = tt1;
    h = g;
    g = rotl(f, 19);
    f = e;
    e = p0(tt2);
  }

  return [
    (a ^ v[0]) >>> 0,
    (b1 ^ v[1]) >>> 0,
    (c ^ v[2]) >>> 0,
    (d ^ v[3]) >>> 0,
    (e ^ v[4]) >>> 0,
    (f ^ v[5]) >>> 0,
    (g ^ v[6]) >>> 0,
    (h ^ v[7]) >>> 0,
  ];
}

/**
 * SM3 摘要: 输入字节数组, 输出 32 字节 hash (Uint8Array)。
 * 对应 gmssl: sm3.sm3_hash(func.bytes_to_list(data)) 的字节结果。
 */
export function sm3Bytes(data: Uint8Array | number[]): Uint8Array {
  const msg = Array.from(data);
  const len = msg.length;

  // 1. 填充: 追加 0x80, 再追加 0 直到长度 ≡ 56 (mod 64), 最后 8 字节为 bit 长度 (大端)。
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  const bitLen = len * 8;
  // 64 位大端 (高 32 位通常为 0, 与 Python bool 位运算一致)
  const high = Math.floor(bitLen / 0x100000000);
  const low = bitLen >>> 0;
  msg.push(...putUint32Be(high), ...putUint32Be(low));

  // 2. 分组迭代: V(i) = CF(V(i-1), B(i)), CF 内部已含 与上一轮 v 的异或。
  let v = IV.slice();
  for (let i = 0; i < msg.length; i += 64) {
    const block = msg.slice(i, i + 64);
    v = cf(v, block);
  }

  // 3. 拼接 8 个 uint32 -> 32 字节
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const bytes = putUint32Be(v[i]);
    out[i * 4] = bytes[0];
    out[i * 4 + 1] = bytes[1];
    out[i * 4 + 2] = bytes[2];
    out[i * 4 + 3] = bytes[3];
  }
  return out;
}

/** SM3 摘要 -> 32 字节 hex 字符串 (小写)。 */
export function sm3Hex(data: Uint8Array | number[] | string): string {
  const bytes =
    typeof data === "string"
      ? Array.from(new TextEncoder().encode(data))
      : Array.from(data);
  return Array.from(sm3Bytes(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
