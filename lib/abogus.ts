/**
 * a_bogus 请求签名 (抖音 web 接口鉴权) —— 纯 TypeScript 移植。
 *
 * 移植自 f2 项目的 f2/utils/abogus.py (Apache-2.0, JohnserfSeed),
 * 算法版本对应 bdms_1.0.1.19_fix。逐函数对照 Python 原版实现,
 * 保持字节级一致, 以便在抖音变更签名方案时快速对照上游打补丁。
 *
 * ⚠️ 已知维护成本: 抖音会周期性轮换签名算法 (例如 X-Bogus → a_bogus),
 *    届时本文件会失效, 需要重新移植。所有签名逻辑集中于此, 便于替换。
 *
 * 用法:
 *   const abogus = generateABogus(paramsString, bodyString, userAgent, fingerprint);
 *   // 把 &a_bogus=<abogus> 追加到请求参数即可。
 *
 * 关键约定 (与 Python 版一致):
 *   - 所有"字符串-字节数组"转换按字节值 (0-255) 处理, 用 String.fromCharCode
 *     / charCodeAt 表达, 不涉及多字节 UTF-8 (UA/fp 均为 ASCII)。
 *   - options: GET 用 [0,1,8], POST 用 [0,1,14]。
 */

import { sm3Bytes } from "./sm3";

// ----------------------------------------------------------------------
// StringProcessor (对应 abogus.py: StringProcessor)
// ----------------------------------------------------------------------

/** Python chr(int) -> 单字符 (字节值 0-255 视作 code point)。 */
function chr(n: number): string {
  return String.fromCharCode(n & 0xff);
}

/** Python ord(char) -> 字节值 (取低 8 位)。 */
function ord(c: string): number {
  return c.charCodeAt(0) & 0xff;
}

/** JS 无符号右移 (Python 没有, 这里模拟 >>>0)。 */
function jsShiftRight(val: number, n: number): number {
  return (val % 0x100000000) >>> n;
}

/** 生成伪随机字节串 (混淆用)。长度 length 组, 每组 4 字节。 */
function generateRandomBytes(length = 3): string {
  const generateByteSequence = (): number[] => {
    const rd = Math.floor(Math.random() * 10000);
    return [
      (rd & 255) & 0xaa | 1,
      (rd & 255) & 0x55 | 2,
      (jsShiftRight(rd, 8) & 0xaa) | 5,
      (jsShiftRight(rd, 8) & 0x55) | 40,
    ];
  };
  const result: number[] = [];
  for (let i = 0; i < length; i++) result.push(...generateByteSequence());
  return result.map(chr).join("");
}

// ----------------------------------------------------------------------
// CryptoUtility (对应 abogus.py: CryptoUtility)
// ----------------------------------------------------------------------

const SALT = "cus"; // bdms_1.0.1.19 的盐

const CHARACTER =
  "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe";
const CHARACTER2 =
  "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe";
const CHARACTER_LIST = [CHARACTER, CHARACTER2];

const UA_KEY = [0x00, 0x01, 0x0e]; // ua 加密 key

// big_array: 固定的 256 字节置换表 (与 Python 版逐字节一致)
const BIG_ARRAY: number[] = [
  121, 243, 55, 234, 103, 36, 47, 228, 30, 231, 106, 6, 115, 95, 78, 101, 250,
  207, 198, 50, 139, 227, 220, 105, 97, 143, 34, 28, 194, 215, 18, 100, 159,
  160, 43, 8, 169, 217, 180, 120, 247, 45, 90, 11, 27, 197, 46, 3, 84, 72, 5,
  68, 62, 56, 221, 75, 144, 79, 73, 161, 178, 81, 64, 187, 134, 117, 186, 118,
  16, 241, 130, 71, 89, 147, 122, 129, 65, 40, 88, 150, 110, 219, 199, 255,
  181, 254, 48, 4, 195, 248, 208, 32, 116, 167, 69, 201, 17, 124, 125, 104, 96,
  83, 80, 127, 236, 108, 154, 126, 204, 15, 20, 135, 112, 158, 13, 1, 188, 164,
  210, 237, 222, 98, 212, 77, 253, 42, 170, 202, 26, 22, 29, 182, 251, 10, 173,
  152, 58, 138, 54, 141, 185, 33, 157, 31, 252, 132, 233, 235, 102, 196, 191,
  223, 240, 148, 39, 123, 92, 82, 128, 109, 57, 24, 38, 113, 209, 245, 2, 119,
  153, 229, 189, 214, 230, 174, 232, 63, 52, 205, 86, 140, 66, 175, 111, 171,
  246, 133, 238, 193, 99, 60, 74, 91, 225, 51, 76, 37, 145, 211, 166, 151, 213,
  206, 0, 200, 244, 176, 218, 44, 184, 172, 49, 216, 93, 168, 53, 21, 183, 41,
  67, 85, 224, 155, 226, 242, 87, 177, 146, 70, 190, 12, 162, 19, 137, 114, 25,
  165, 163, 192, 23, 59, 9, 94, 179, 107, 35, 7, 142, 131, 239, 203, 149, 136,
  61, 249, 14, 156,
];

/** SM3 摘要 -> 字节值数组 (32 个 0-255 整数)。对应 CryptoUtility.sm3_to_array。 */
function sm3ToArray(input: string | number[]): number[] {
  let bytes: number[];
  if (typeof input === "string") {
    // UA/params/body 均为 ASCII; 用 latin1 逐字节取, 与 Python utf-8(ASCII 子集) 一致
    bytes = Array.from(input).map((c) => c.charCodeAt(0));
    // 处理潜在的多字节字符 (理论上不该出现): 折回 utf-8 字节
    if (bytes.some((b) => b > 0xff)) {
      bytes = Array.from(new TextEncoder().encode(input));
    }
  } else {
    bytes = input;
  }
  return Array.from(sm3Bytes(bytes));
}

/** 取输入参数的哈希数组 (按需加盐)。 */
function paramsToArray(param: string | number[], addSalt = true): number[] {
  let p = param;
  if (typeof p === "string" && addSalt) p = p + SALT;
  return sm3ToArray(p);
}

/** RC4 加密 -> 字节值数组。对应 CryptoUtility.rc4_encrypt。 */
function rc4Encrypt(key: number[], plaintext: string): number[] {
  const S = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) % 256;
    [S[i], S[j]] = [S[j], S[i]];
  }
  let ii = 0;
  j = 0;
  const out: number[] = [];
  for (let k = 0; k < plaintext.length; k++) {
    ii = (ii + 1) % 256;
    j = (j + S[ii]) % 256;
    [S[ii], S[j]] = [S[j], S[ii]];
    const K = S[(S[ii] + S[j]) % 256];
    out.push(plaintext.charCodeAt(k) ^ K);
  }
  return out;
}

/** 自定义字符表 Base64 编码。对应 CryptoUtility.base64_encode。 */
function base64Encode(input: string, selectedAlphabet = 0): string {
  let binary = "";
  for (const ch of input) binary += ord(ch).toString(2).padStart(8, "0");
  const paddingLength = (6 - (binary.length % 6)) % 6;
  binary += "0".repeat(paddingLength);
  let out = "";
  for (let i = 0; i < binary.length; i += 6) {
    const idx = parseInt(binary.slice(i, i + 6), 2);
    out += CHARACTER_LIST[selectedAlphabet][idx];
  }
  out += "=".repeat(paddingLength / 2);
  return out;
}

/**
 * 字节串 -> 字符串的"加密/解密" (基于 big_array 的流式置换)。
 * ⚠️ 该函数会就地修改 BIG_ARRAY, 因此每次调用必须用其副本。
 * 对应 CryptoUtility.transform_bytes。
 */
function transformBytes(bytesList: number[], bigArr: number[]): string {
  const bytesStr = bytesList.map(chr).join("");
  const result: string[] = [];
  let indexB = bigArr[1];
  let initialValue = 0;
  let sumInitial = 0;
  let valueE = 0;
  let valueF = 0;

  for (let index = 0; index < bytesStr.length; index++) {
    if (index === 0) {
      initialValue = bigArr[indexB];
      sumInitial = indexB + initialValue;
      bigArr[1] = initialValue;
      bigArr[indexB] = indexB;
    } else {
      sumInitial = initialValue + valueE;
    }
    const charValue = ord(bytesStr[index]);
    sumInitial %= bigArr.length;
    valueF = bigArr[sumInitial];
    result.push(chr(charValue ^ valueF));

    // 交换数组元素
    valueE = bigArr[(index + 2) % bigArr.length];
    sumInitial = (indexB + valueE) % bigArr.length;
    initialValue = bigArr[sumInitial];
    bigArr[sumInitial] = bigArr[(index + 2) % bigArr.length];
    bigArr[(index + 2) % bigArr.length] = initialValue;
    indexB = sumInitial;
  }
  return result.join("");
}

/** abogus 自定义 Base64 编码 (位移 + 填充)。对应 CryptoUtility.abogus_encode。 */
function abogusEncode(abogusBytesStr: string, selectedAlphabet: number): string {
  const out: string[] = [];
  const masks = [0xfc0000, 0x03f000, 0x0fc0, 0x3f];
  const shifts = [18, 12, 6, 0];

  for (let i = 0; i < abogusBytesStr.length; i += 3) {
    let n: number;
    if (i + 2 < abogusBytesStr.length) {
      n =
        (ord(abogusBytesStr[i]) << 16) |
        (ord(abogusBytesStr[i + 1]) << 8) |
        ord(abogusBytesStr[i + 2]);
    } else if (i + 1 < abogusBytesStr.length) {
      n = (ord(abogusBytesStr[i]) << 16) | (ord(abogusBytesStr[i + 1]) << 8);
    } else {
      n = ord(abogusBytesStr[i]) << 16;
    }

    for (let k = 0; k < 4; k++) {
      const j = shifts[k];
      if (j === 6 && i + 1 >= abogusBytesStr.length) break;
      if (j === 0 && i + 2 >= abogusBytesStr.length) break;
      out.push(CHARACTER_LIST[selectedAlphabet][(n & masks[k]) >>> j]);
    }
  }
  out.push("=".repeat((4 - (out.length % 4)) % 4));
  return out.join("");
}

// ----------------------------------------------------------------------
// 浏览器指纹 (对应 BrowserFingerprintGenerator)
// ----------------------------------------------------------------------

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 生成 Edge 风格浏览器指纹串 (与 Python 版格式一致)。 */
export function generateFingerprint(platform = "Win32"): string {
  const innerW = randInt(1024, 1920);
  const innerH = randInt(768, 1080);
  const outerW = innerW + randInt(24, 32);
  const outerH = innerH + randInt(75, 90);
  const screenX = 0;
  const screenY = randChoice([0, 30]);
  const sizeW = randInt(1024, 1920);
  const sizeH = randInt(768, 1080);
  const availW = randInt(1280, 1920);
  const availH = randInt(800, 1080);
  return (
    `${innerW}|${innerH}|${outerW}|${outerH}|` +
    `${screenX}|${screenY}|0|0|${sizeW}|${sizeH}|` +
    `${availW}|${availH}|${innerW}|${innerH}|24|24|${platform}`
  );
}

// ----------------------------------------------------------------------
// ABogus 主类 (对应 abogus.py: ABogus)
// ----------------------------------------------------------------------

const AID = 6383;
const PAGE_ID = 0; // bdms_1.0.1.19 -> 0
const SORT_INDEX = [
  18, 20, 52, 26, 30, 34, 58, 38, 40, 53, 42, 21, 27, 54, 55, 31, 35, 57, 39,
  41, 43, 22, 28, 32, 60, 36, 23, 29, 33, 37, 44, 45, 59, 46, 47, 48, 49, 50,
  24, 25, 65, 66, 70, 71,
];
const SORT_INDEX_2 = [
  18, 20, 26, 30, 34, 38, 40, 42, 21, 27, 31, 35, 39, 41, 43, 22, 28, 32, 36,
  23, 29, 33, 37, 44, 45, 46, 47, 48, 49, 50, 24, 25, 52, 53, 54, 55, 57, 58,
  59, 60, 65, 66, 70, 71,
];

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

export interface ABogusResult {
  /** 完整参数串 (params + &a_bogus=...) */
  params: string;
  /** 仅 a_bogus 值 */
  abogus: string;
  /** 使用的 UA */
  userAgent: string;
  /** 使用的浏览器指纹 */
  fingerprint: string;
}

/**
 * 生成 a_bogus 签名。
 *
 * @param params  请求参数串 (key=value&..., 不含 a_bogus)
 * @param body    请求体 (GET 传 "")
 * @param userAgent 自定义 UA (留空用默认)
 * @param fingerprint 自定义浏览器指纹 (留空随机生成)
 * @param options  GET=[0,1,8] / POST=[0,1,14]
 *
 * 对应 ABogus.generate_abogus。
 */
export function generateABogus(
  params: string,
  body = "",
  userAgent = "",
  fingerprint = "",
  options: number[] = [0, 1, 14],
): ABogusResult {
  const ua = userAgent || DEFAULT_UA;
  const fp = fingerprint || generateFingerprint("Win32");

  // ab_dir: 用普通对象, 键为整数索引
  const abDir: Record<number, number | object> = {
    8: 3, // 固定
    15: {
      aid: AID,
      pageId: PAGE_ID,
      boe: false,
      ddrt: 8.5,
      paths: [
        "^/webcast/",
        "^/aweme/v1/",
        "^/aweme/v2/",
        "/v1/message/send",
        "^/live/",
        "^/captcha/",
        "^/ecom/",
      ],
      track: { mode: 0, delay: 300, paths: [] },
      dump: true,
      rpU: "",
    },
    18: 44,
    19: [1, 0, 1, 0, 1],
    66: 0,
    69: 0,
    70: 0,
    71: 0,
  };
  const getN = (i: number): number =>
    typeof abDir[i] === "number" ? (abDir[i] as number) : 0;

  const startEncryption = Date.now();

  // 三路 SM3: params / body / ua(先 RC4 再 base64)
  const array1 = paramsToArray(paramsToArray(params));
  const array2 = paramsToArray(paramsToArray(body));
  const rc4Ua = rc4Encrypt(UA_KEY, ua); // bytes[]
  const uaStr = rc4Ua.map(chr).join(""); // to_ord_str
  const array3 = paramsToArray(base64Encode(uaStr, 1), false);

  const endEncryption = Date.now();

  // 插入加密开始时间
  abDir[20] = (startEncryption >>> 24) & 255;
  abDir[21] = (startEncryption >>> 16) & 255;
  abDir[22] = (startEncryption >>> 8) & 255;
  abDir[23] = startEncryption & 255;
  abDir[24] = Math.floor(startEncryption / 256 / 256 / 256 / 256) >> 0;
  abDir[25] = Math.floor(startEncryption / 256 / 256 / 256 / 256 / 256) >> 0;

  // 请求头配置
  abDir[26] = (options[0] >>> 24) & 255;
  abDir[27] = (options[0] >>> 16) & 255;
  abDir[28] = (options[0] >>> 8) & 255;
  abDir[29] = options[0] & 255;

  // 请求方法
  abDir[30] = (Math.floor(options[1] / 256)) & 255;
  abDir[31] = (options[1] % 256) & 255;
  abDir[32] = (options[1] >>> 24) & 255;
  abDir[33] = (options[1] >>> 16) & 255;

  // 请求头加密
  abDir[34] = (options[2] >>> 24) & 255;
  abDir[35] = (options[2] >>> 16) & 255;
  abDir[36] = (options[2] >>> 8) & 255;
  abDir[37] = options[2] & 255;

  // 请求体 / body / ua 加密
  abDir[38] = array1[21];
  abDir[39] = array1[22];
  abDir[40] = array2[21];
  abDir[41] = array2[22];
  abDir[42] = array3[23];
  abDir[43] = array3[24];

  // 加密结束时间
  abDir[44] = (endEncryption >>> 24) & 255;
  abDir[45] = (endEncryption >>> 16) & 255;
  abDir[46] = (endEncryption >>> 8) & 255;
  abDir[47] = endEncryption & 255;
  abDir[48] = abDir[8];
  abDir[49] = Math.floor(endEncryption / 256 / 256 / 256 / 256) >> 0;
  abDir[50] = Math.floor(endEncryption / 256 / 256 / 256 / 256 / 256) >> 0;

  // 固定值
  abDir[51] = (PAGE_ID >>> 24) & 255;
  abDir[52] = (PAGE_ID >>> 16) & 255;
  abDir[53] = (PAGE_ID >>> 8) & 255;
  abDir[54] = PAGE_ID & 255;
  abDir[55] = PAGE_ID;
  abDir[56] = AID;
  abDir[57] = AID & 255;
  abDir[58] = (AID >>> 8) & 255;
  abDir[59] = (AID >>> 16) & 255;
  abDir[60] = (AID >>> 24) & 255;

  // 浏览器指纹长度
  abDir[64] = fp.length;
  abDir[65] = fp.length;

  // 取 sort_index 对应值
  const sortedValues = SORT_INDEX.map((i) => getN(i));

  // 指纹 ASCII 码
  const edgeFpArray: number[] = [];
  for (const c of fp) edgeFpArray.push(ord(c));

  // 异或计算
  let abXor = 0;
  for (let index = 0; index < SORT_INDEX_2.length - 1; index++) {
    if (index === 0) abXor = getN(SORT_INDEX_2[index]);
    abXor ^= getN(SORT_INDEX_2[index + 1]);
  }

  sortedValues.push(...edgeFpArray);
  sortedValues.push(abXor);

  // ⚠️ transformBytes 会就地改 big_array -> 必须用副本
  const bigCopy = BIG_ARRAY.slice();
  const abogusBytesStr =
    generateRandomBytes() + transformBytes(sortedValues, bigCopy);

  const abogus = abogusEncode(abogusBytesStr, 0);
  return {
    params: `${params}&a_bogus=${abogus}`,
    abogus,
    userAgent: ua,
    fingerprint: fp,
  };
}
