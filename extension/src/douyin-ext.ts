/**
 * 抖音无水印视频/图集解析核心 (浏览器插件版)。
 *
 * 从本项目 lib/douyin.ts 派生, 保留全部纯解析逻辑 (_ROUTER_DATA 括号深度匹配、
 * walkFind / getAllQualities / isAlbum / getAlbumImages / findCover), 仅改造 HTTP 层:
 *
 *   - 浏览器 service worker 无法设置 forbidden header (User-Agent / Referer),
 *     这些由 manifest 的 declarativeNetRequest 静态规则注入, 代码里不再手设。
 *   - 不使用 redirect:"manual" (浏览器里是 opaque-redirect, 读不到 Location);
 *     /video/ /note/ 长链已直接命中 ID, 短链用普通 follow 让浏览器自动跳转。
 *   - 新增 /note/(\d+) 分支以支持图集页 (原版只有 /video/)。
 *
 * 与原版一样: 走 iesdouyin 移动端分享页, 不依赖 a_bogus 签名, 是最稳定的路径。
 */

// ----------------------------------------------------------------------
// 常量 / 类型
// ----------------------------------------------------------------------

/** 移动端分享页首页, 作为 Referer 目标 (由 DNR 注入, 这里仅作记录)。 */
export const HOMEPAGE_URL = "https://www.iesdouyin.com/";

/**
 * 清晰度档位 (ratio 值 -> 展示名), 与 lib/douyin.ts 保持一致。
 * 含 "default"(原画/原始流) = 其他下载站的「超高清」: 不转码, 画质最高,
 * 文件通常比 1080p 大 3~5 倍。
 *
 * 注: 插件侧不服务端探测各档真实大小/去重 (SW 无法设 forbidden header,
 * 且插件是点对点下载、延迟敏感)。若某档对该视频实际不存在, CDN 会静默降级,
 * 下载仍可成功 (只是画质为低清) —— 与网页版的探测去重为「最佳/最稳」取舍。
 */
export const QUALITY_RATIOS: Array<[string, string]> = [
  ["default", "超高清"], // 原画/原始流 (最高画质)
  ["1080p", "1080P"],
  ["720p", "720P"],
  ["540p", "540P"],
];

export interface Quality {
  ratio: string;
  label: string;
  url: string;
  /** 文件字节数 (插件不填, 仅为与网页版协议一致)。 */
  size?: number;
}

export interface ParseResult {
  aweme_id: string;
  title: string;
  author: string;
  /** 默认清晰度地址 (720p 或首个), 兼容前端。 */
  video_url: string;
  qualities: Quality[];
  cover_url: string | null;
  source_url: string;
  type: "video";
}

export interface AlbumImage {
  /** 无水印原图 URL (download_url_list[0], 带签名有时效)。 */
  url: string;
  /** 预览图 (url_list[0], 较低清, 供 UI 缩略图)。 */
  preview: string | null;
  width: number;
  height: number;
}

export interface AlbumResult {
  aweme_id: string;
  title: string;
  author: string;
  cover_url: string | null;
  source_url: string;
  images: AlbumImage[];
  type: "album";
}

export type AnyParseResult = ParseResult | AlbumResult;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

// ----------------------------------------------------------------------
// 链接 / ID 解析
// ----------------------------------------------------------------------

/** 从分享文本中提取 http(s) 链接。 */
export function extractUrl(text: string): string {
  if (!text) throw new Error("输入为空");
  const m = text.match(/https?:\/\/[^\s，。、；]+/);
  if (!m) throw new Error(`未在输入中找到链接: ${text}`);
  return m[0];
}

/**
 * 从 URL 里直接提取 aweme_id (不发起网络请求)。
 *
 * 支持:
 *   - 长链 /video/{id}    (普通视频)
 *   - 长链 /note/{id}     (图集, 原版未支持)
 *   - query 里的 aweme_id
 * 匹配不到返回 null, 交由调用方走短链重定向分支。
 */
export function extractAwemeIdFromUrl(url: string): string | null {
  const m = url.match(/\/(?:video|note)\/(\d+)/);
  if (m && m[1]) return m[1];
  const q = url.match(/[?&]aweme_id=(\d+)/);
  if (q && q[1]) return q[1];
  return null;
}

/**
 * 从任意抖音链接解析出 aweme_id。
 *
 * - 长链 (/video /note) / query: 直接正则取。
 * - 短链 (v.douyin.com): 用普通 fetch 让浏览器自动跟随重定向,
 *   再从最终 URL 取 (浏览器里 redirect:manual 是 opaque, 不能用)。
 */
export async function getAwemeId(url: string): Promise<string> {
  const direct = extractAwemeIdFromUrl(url);
  if (direct) return direct;

  // 短链: 跟随重定向后从最终 URL 提取。
  // 注: SW fetch 受 DNR 规则影响会带正确 UA/Referer, 此处只需读 final URL。
  try {
    const resp = await fetch(url, {
      redirect: "follow",
      // Referer/UA 由 DNR 注入; 不在此设置 forbidden header
    });
    const finalUrl = resp.url || url;
    const m1 = extractAwemeIdFromUrl(finalUrl);
    if (m1) return m1;
    // 兜底: 匹配一长串数字
    const m2 = finalUrl.match(/(\d{15,})/);
    if (m2) return m2[1];
  } catch {
    /* 忽略, 抛下面的统一错误 */
  }
  throw new Error(`无法从链接解析视频 ID: ${url}`);
}

// ----------------------------------------------------------------------
// 分享页请求 (浏览器版: 无手设 UA/Referer, 由 DNR 注入)
// ----------------------------------------------------------------------

/** 请求移动端分享页 HTML。 */
export async function fetchSharePage(awemeId: string): Promise<string> {
  const url = `https://www.iesdouyin.com/share/video/${awemeId}/`;
  const resp = await fetch(url, {
    redirect: "follow",
    // UA/Referer 由 DNR 规则注入 (forbidden header 在 SW 里设了也会被丢弃)
  });
  if (!resp.ok) throw new Error(`分享页请求失败: HTTP ${resp.status}`);
  const text = await resp.text();
  if (!text) throw new Error("分享页返回空内容");
  return text;
}

// ----------------------------------------------------------------------
// _ROUTER_DATA JSON 提取 (括号深度匹配, 逐字复用自 lib/douyin.ts)
// ----------------------------------------------------------------------

export function extractRouterData(html: string): Json | null {
  const marker = "window._ROUTER_DATA = ";
  let idx = html.indexOf(marker);
  let start: number;
  if (idx < 0) {
    idx = html.indexOf("_ROUTER_DATA");
    if (idx < 0) return null;
    const eq = html.indexOf("=", idx);
    if (eq < 0) return null;
    start = eq + 1;
  } else {
    start = idx + marker.length;
  }

  while (start < html.length && /\s/.test(html[start])) start++;
  if (start >= html.length || html[start] !== "{") return null;

  // 括号深度匹配 (考虑字符串内的括号和转义)
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const raw = html.slice(start, i + 1);
        try {
          return JSON.parse(raw) as Json;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ----------------------------------------------------------------------
// JSON 递归提取 (逐字复用自 lib/douyin.ts)
// ----------------------------------------------------------------------

interface FoundMeta {
  playApi?: string;
  playUrls: string[];
  videoId?: string;
  title?: string;
  author?: string;
}

function walkFind(obj: Json, found: FoundMeta): void {
  if (Array.isArray(obj)) {
    for (const v of obj) walkFind(v, found);
    return;
  }
  if (typeof obj !== "object" || obj === null) return;

  if (typeof obj.playApi === "string" && obj.playApi && !found.playApi) {
    found.playApi = obj.playApi;
  }

  if (Array.isArray(obj.url_list) && obj.url_list.length) {
    const urls = obj.url_list.filter(
      (u): u is string => typeof u === "string" && u.length > 0,
    );
    if (urls.length && urls.some((u) => u.includes("play"))) {
      found.playUrls.push(...urls);
    }
  }

  // uri -> video_id (形如 v0300fg10000d8dd3ivog65gljtkshi0)
  if (typeof obj.uri === "string" && !found.videoId) {
    if (/^v0[0-9a-f]+$/.test(obj.uri)) found.videoId = obj.uri;
  }

  if (typeof obj.desc === "string" && !found.title) found.title = obj.desc;
  if (typeof obj.nickname === "string" && !found.author)
    found.author = obj.nickname;

  for (const v of Object.values(obj)) walkFind(v, found);
}

/** 根据 video_id 和 ratio 构造无水印播放地址 (用 /play/ 而非 /playwm/)。 */
function buildPlayUrl(
  videoId: string,
  ratio: string,
  baseUrl?: string | null,
): string {
  if (baseUrl) {
    const m = baseUrl.match(/(https?:\/\/[^/]+\/aweme\/v1\/play(?:wm)?\/)/);
    const prefix = m
      ? m[1].replace("playwm", "play")
      : "https://aweme.snssdk.com/aweme/v1/play/";
    let extra = "";
    const em = baseUrl.match(/&(line=\d+)/);
    if (em) extra = "&" + em[1];
    return `${prefix}?video_id=${videoId}&ratio=${ratio}${extra}`;
  }
  return `https://aweme.snssdk.com/aweme/v1/play/?video_id=${videoId}&ratio=${ratio}&line=0`;
}

/** 从解析数据中提取所有清晰度选项。 */
export function getAllQualities(data: Json): Quality[] {
  const found: FoundMeta = { playUrls: [] };
  walkFind(data, found);

  let videoId = found.videoId;
  if (!videoId) {
    for (const u of found.playUrls) {
      const m = u.match(/video_id=([0-9a-zA-Z]+)/);
      if (m) {
        videoId = m[1];
        break;
      }
    }
  }
  if (!videoId) return [];

  const template = found.playUrls.find((u) => u.includes("video_id=")) || null;

  const qualities: Quality[] = [];
  for (const [ratio, label] of QUALITY_RATIOS) {
    qualities.push({
      ratio,
      label,
      url: buildPlayUrl(videoId, ratio, template),
    });
  }
  return qualities;
}

/** 在解析出的 JSON 中查找封面图 URL。 */
export function findCover(data: Json): string | null {
  const found: { url: string | null } = { url: null };

  const walk = (obj: Json): void => {
    if (found.url) return;
    if (Array.isArray(obj)) {
      for (const v of obj) {
        walk(v);
        if (found.url) return;
      }
      return;
    }
    if (typeof obj !== "object" || obj === null) return;
    for (const [key, val] of Object.entries(obj)) {
      if (
        key.toLowerCase().includes("cover") &&
        val &&
        typeof val === "object" &&
        Array.isArray((val as { url_list?: Json }).url_list) &&
        typeof (val as { url_list: Json[] }).url_list[0] === "string"
      ) {
        found.url = (val as { url_list: string[] }).url_list[0];
        return;
      }
      walk(val);
      if (found.url) return;
    }
  };
  walk(data);
  return found.url;
}

function extractMeta(data: Json): { title?: string; author?: string } {
  const found: FoundMeta = { playUrls: [] };
  walkFind(data, found);
  return { title: found.title, author: found.author };
}

// ----------------------------------------------------------------------
// 图集 (图文) 解析 (逐字复用自 lib/douyin.ts)
// ----------------------------------------------------------------------

/** 递归查找含 `images` 数组的节点 (图集 item)。 */
function findAlbumNode(data: Json): Record<string, Json> | null {
  const walk = (obj: Json): Record<string, Json> | null => {
    if (!obj || typeof obj !== "object") return null;
    if (Array.isArray(obj)) {
      for (const v of obj) {
        const r = walk(v);
        if (r) return r;
      }
      return null;
    }
    const o = obj as Record<string, Json>;
    if (Array.isArray(o.images) && o.images.length > 0) {
      return o;
    }
    for (const v of Object.values(o)) {
      const r = walk(v);
      if (r) return r;
    }
    return null;
  };
  return walk(data);
}

/** 判断解析数据是否为图集 (图文作品)。 */
export function isAlbum(data: Json): boolean {
  const node = findAlbumNode(data);
  if (!node) return false;
  const images = (node as { images?: Json[] }).images;
  return Array.isArray(images) && images.length > 0;
}

/** 提取图集的无水印原图列表。 */
export function getAlbumImages(data: Json): AlbumImage[] {
  const node = findAlbumNode(data);
  if (!node) return [];
  const images = (node.images as Json[]).filter(
    (img): img is Record<string, Json> =>
      !!img && typeof img === "object" && !Array.isArray(img),
  );
  const out: AlbumImage[] = [];
  for (const img of images) {
    const dlList = img.download_url_list as Json[] | undefined;
    const urlList = img.url_list as Json[] | undefined;
    const url =
      Array.isArray(dlList) && typeof dlList[0] === "string"
        ? (dlList[0] as string)
        : Array.isArray(urlList) && typeof urlList[0] === "string"
          ? (urlList[0] as string)
          : "";
    if (!url) continue;
    const preview =
      Array.isArray(urlList) && typeof urlList[0] === "string"
        ? (urlList[0] as string)
        : null;
    out.push({
      url,
      preview,
      width: typeof img.width === "number" ? img.width : 0,
      height: typeof img.height === "number" ? img.height : 0,
    });
  }
  return out;
}

// ----------------------------------------------------------------------
// 主解析入口 (浏览器版: 接收已解析的 awemeId + sourceUrl, 跳过短链解析)
// ----------------------------------------------------------------------

/**
 * 解析抖音 aweme_id, 返回视频或图集信息 (自动识别)。
 *
 * @param awemeId 视频唯一 ID
 * @param sourceUrl 原始来源 URL (用于回填, 可选)
 */
export async function parseByAwemeId(
  awemeId: string,
  sourceUrl?: string,
): Promise<AnyParseResult> {
  const html = await fetchSharePage(awemeId);
  const data = extractRouterData(html);
  if (!data) throw new Error("无法解析页面数据, 抖音接口可能已变更");

  const meta = extractMeta(data);
  const coverUrl = findCover(data);
  const src = sourceUrl || `https://www.douyin.com/video/${awemeId}`;

  // 优先图集路径
  if (isAlbum(data)) {
    const images = getAlbumImages(data);
    if (images.length) {
      return {
        aweme_id: awemeId,
        title: meta.title || awemeId,
        author: meta.author || "",
        cover_url: coverUrl,
        source_url: src,
        images,
        type: "album",
      };
    }
  }

  // 视频路径
  const qualities = getAllQualities(data);
  if (!qualities.length) throw new Error("未能从页面找到视频地址");

  // 默认选 720p (兼顾画质与体积); 720p 缺失时回退首个非超高清档, 再兜底超高清。
  const defaultUrl =
    qualities.find((q) => q.ratio === "720p")?.url ||
    qualities.find((q) => q.ratio !== "default")?.url ||
    qualities[0].url;

  return {
    aweme_id: awemeId,
    title: meta.title || awemeId,
    author: meta.author || "",
    video_url: defaultUrl,
    qualities,
    cover_url: coverUrl,
    source_url: src,
    type: "video",
  };
}

/**
 * 从分享文案/链接解析 (popup 入口用)。
 * 提取链接 → 解析 aweme_id → parseByAwemeId。
 */
export async function parseDouyin(text: string): Promise<AnyParseResult> {
  const url = extractUrl(text);
  const awemeId = await getAwemeId(url);
  return parseByAwemeId(awemeId, url);
}

/** 清洗文件名中的非法字符 (逐字复用自 lib/douyin.ts)。 */
export function sanitizeFilename(name: string, maxLen = 80): string {
  let n = name.replace(/[\\/:*?"<>|\n\r\t]/g, " ").trim();
  n = n.replace(/\s+/g, " ");
  if (n.length > maxLen) n = n.slice(0, maxLen).trim();
  return n || "douyin_video";
}

/** 构造视频文件名: 作者_标题_清晰度.mp4 (复用自 app/page.tsx 的 buildFilename)。 */
export function buildVideoFilename(
  author: string,
  title: string,
  qualityTag: string,
): string {
  const name =
    (author ? author + "_" : "") +
    title +
    (qualityTag ? "_" + qualityTag : "") +
    ".mp4";
  return sanitizeFilename(name);
}

/** 从图片 URL 猜测扩展名 (复用自 app/page.tsx 的 guessImgExtFromUrl)。 */
export function guessImgExtFromUrl(url: string): string {
  const u = url.toLowerCase();
  if (u.includes(".png")) return "png";
  if (u.includes(".jpg") || u.includes(".jpeg")) return "jpg";
  return "webp";
}
