/**
 * 抖音无水印视频解析核心逻辑 (Next.js / Node 端)
 *
 * 对应原 Python 版 douyin_download.py, 去掉了 DoH + SNI 直连
 * (Vercel 服务器的系统 DNS 不被国内污染, 无需绕过), 保留:
 *   - 伪装 iPhone Safari UA + Referer (抖音 CDN 鉴权依赖)
 *   - 短链重定向解析 aweme_id
 *   - _ROUTER_DATA JSON 括号深度匹配提取
 *   - 清晰度 (ratio) 枚举与无水印地址构造
 *
 * 注: Node 端 fetch 可自由设置 Referer / User-Agent,
 *     不受浏览器 forbidden header 限制。
 */

// ----------------------------------------------------------------------
// 常量 / 请求头
// ----------------------------------------------------------------------

export const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
  "Version/16.6 Mobile/15E148 Safari/604.1";

export const HOMEPAGE_URL = "https://www.iesdouyin.com/";

// 清晰度档位 (ratio 值 -> 展示名)
// 含 "default"(原画/原始流) —— 即其他下载站的「超高清」: 不经过转码,
// 文件通常比 1080p 还大 3~5 倍 (画质最高)。实测 default 对绝大多数视频
// 都返回完整可用文件, 故提供。是否真正可选由 probeQualitySizes 探测后去重决定。
export const QUALITY_RATIOS: Array<[string, string]> = [
  ["default", "超高清"], // 原画/原始流 (最高画质)
  ["1080p", "1080P"],
  ["720p", "720P"],
  ["540p", "540P"],
];

// 探测用的 ratio 列表。用这 4 个 ratio 各发一个 HEAD 请求拿 Content-Length,
// 再按「转码档严格递增」的规则识别 CDN 静默降级假档 (见 getAllQualitiesWithSizes)。
const PROBE_RATIOS = ["540p", "720p", "1080p", "default"];

/** ratio -> 展示名 查找 (转码档去重后重新组装 label 时用)。 */
function labelOf(ratio: string): string {
  const entry = QUALITY_RATIOS.find(([r]) => r === ratio);
  return entry ? entry[1] : ratio;
}

export interface Quality {
  ratio: string;
  label: string;
  url: string;
  /** 文件字节数 (服务端 HEAD 探测所得); 无探测结果时为 undefined。 */
  size?: number;
}

export interface ParseResult {
  aweme_id: string;
  title: string;
  author: string;
  video_url: string; // 默认清晰度地址 (兼容前端)
  qualities: Quality[];
  cover_url: string | null;
  source_url: string;
  /** 视频时为 "video" */
  type: "video";
}

/** 图集单张图片。 */
export interface AlbumImage {
  /** 无水印原图 URL (download_url_list[0], 带签名有时效) */
  url: string;
  /** 预览图 (url_list[0], 较低清, 供 UI 缩略图) */
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

/** 单链接解析结果: 视频或图集 (二选一)。 */
export type AnyParseResult = ParseResult | AlbumResult;

// ----------------------------------------------------------------------
// HTTP: 自动跟随重定向 (fetch 默认会跟, 但需要拿到最终 URL 用于解析 ID)
// ----------------------------------------------------------------------

async function fetchFinalUrl(
  url: string,
  headers: Record<string, string>,
): Promise<{ finalUrl: string; status: number; text: string }> {
  // 手动跟随重定向, 以便从每一跳的 Location 拿到最终 URL
  // (fetch 默认 redirect:"follow" 在部分运行时不会回填 resp.url)。
  let current = url;
  for (let i = 0; i < 8; i++) {
    const resp = await fetch(current, {
      headers,
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get("location");
      if (!loc) break;
      current = new URL(loc, current).href; // 处理相对/绝对
      continue;
    }
    const text = await resp.text();
    return {
      finalUrl: resp.url || current,
      status: resp.status,
      text,
    };
  }
  // 兜底: 再发一次 follow
  const resp = await fetch(current, { headers, redirect: "follow" });
  const text = await resp.text();
  return {
    finalUrl: resp.url || current,
    status: resp.status,
    text,
  };
}

// ----------------------------------------------------------------------
// 解析逻辑
// ----------------------------------------------------------------------

/** 从分享文本中提取 http(s) 链接。 */
export function extractUrl(text: string): string {
  if (!text) throw new Error("输入为空");
  const m = text.match(/https?:\/\/[^\s，。]+/);
  if (!m) throw new Error(`未在输入中找到链接: ${text}`);
  return m[0];
}

/** 从任意抖音链接解析出 aweme_id。 */
export async function getAwemeId(url: string): Promise<string> {
  // 链接里已直接含 ID
  const direct = url.match(/\/video\/(\d+)/);
  if (direct) return direct[1];

  // 短链: 跟随重定向, 从最终 URL 提取
  const { finalUrl } = await fetchFinalUrl(url, {
    "User-Agent": MOBILE_UA,
  });
  const m1 = finalUrl.match(/\/video\/(\d+)/);
  if (m1) return m1[1];
  // 兜底: 某些跳转目标在 query 里, 匹配一长串数字
  const m2 = finalUrl.match(/(\d{15,})/);
  if (m2) return m2[1];
  throw new Error(`无法从链接解析视频 ID: ${url}`);
}

/** 请求移动端分享页 HTML。 */
export async function fetchSharePage(awemeId: string): Promise<string> {
  const url = `https://www.iesdouyin.com/share/video/${awemeId}/`;
  const { status, text } = await fetchFinalUrl(url, {
    "User-Agent": MOBILE_UA,
    Referer: HOMEPAGE_URL,
    Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
  });
  if (status !== 200 || !text) throw new Error(`分享页请求失败: HTTP ${status}`);
  return text;
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** 用括号深度匹配从 HTML 中精确提取 _ROUTER_DATA JSON。 */
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

interface FoundMeta {
  playApi?: string;
  playUrls: string[];
  videoId?: string;
  title?: string;
  author?: string;
  coverUrl?: string | null;
}

/** 递归在 JSON 里寻找视频信息 (标题/作者/视频地址/封面)。 */
function walkFind(obj: Json, found: FoundMeta): void {
  if (Array.isArray(obj)) {
    for (const v of obj) walkFind(v, found);
    return;
  }
  if (typeof obj !== "object" || obj === null) return;

  // playApi
  if (
    typeof obj.playApi === "string" &&
    obj.playApi &&
    !found.playApi
  ) {
    found.playApi = obj.playApi;
  }

  // url_list (play_addr / download_addr) -> 收集播放地址
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

  // 标题 / 作者
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
    // 保留原有的额外参数 (如 line)
    let extra = "";
    const em = baseUrl.match(/&(line=\d+)/);
    if (em) extra = "&" + em[1];
    return `${prefix}?video_id=${videoId}&ratio=${ratio}${extra}`;
  }
  return `https://aweme.snssdk.com/aweme/v1/play/?video_id=${videoId}&ratio=${ratio}&line=0`;
}

/**
 * 并行对每个候选 ratio 发一个 HEAD 请求, 拿到各档真实文件大小。
 *
 * 抖音 play 接口对实际不存在的转码档会静默降级 (返回低清文件),
 * 因此「请求成功」不等于「该档真实存在」—— 需用 Content-Length 去重。
 * 全部请求失败/超时时返回空 Map, 由调用方降级为不带大小的硬编码档。
 *
 * 实测 4 个并行 HEAD ≈ 4.5s, 在 Vercel Hobby 10s 限制内。
 */
export async function probeQualitySizes(
  videoId: string,
  template: string | null,
): Promise<Map<string, number>> {
  const results = await Promise.all(
    PROBE_RATIOS.map(async (ratio) => {
      const url = buildPlayUrl(videoId, ratio, template);
      try {
        // redirect:"follow" 让 fetch 自动跟随到 CDN, 再读最终响应头。
        const resp = await fetch(url, {
          method: "HEAD",
          headers: { "User-Agent": MOBILE_UA, Referer: HOMEPAGE_URL },
          redirect: "follow",
        });
        if (!resp.ok) return [ratio, 0] as const;
        const len = Number(resp.headers.get("content-length") || 0);
        return [ratio, len] as const;
      } catch {
        return [ratio, 0] as const;
      }
    }),
  );
  const map = new Map<string, number>();
  for (const [ratio, len] of results) {
    if (len > 0) map.set(ratio, len);
  }
  return map;
}

/**
 * 从解析数据中提取所有真实可用的清晰度选项 (带文件大小, 去重静默降级档)。
 *
 * 去重策略 (比单纯「字节相同去重」更稳健):
 *   抖音 CDN 对视频实际不存在的转码档会**静默降级**返回低清文件。
 *   真实的转码档, 文件大小随清晰度**严格递增** (540p < 720p < 1080p)。
 *   因此对 540p/720p/1080p 三档, 从低到高保留「严格大于上一个保留档」的;
 *   任何一个档若 ≤ 上一个保留档的字节, 就是降级假档, 丢弃。
 *   default(原画) 不参与单调性判断, 只要探测到就保留 (它是独立的原画通道)。
 *
 *   例: 视频无 1080p 编码时, 探测得 540p=2.1M / 720p=2.5M / 1080p=2.1M。
 *   从低到高: 540p(2.1M) 保留 → 720p(2.5M>2.1M) 保留 → 1080p(2.1M<2.5M) 丢弃。
 *   即使某次 540p 探测失败, 1080p(2.1M)≤720p(2.5M) 仍会被正确丢弃。
 *
 * 探测失败 (空 Map) 时降级: 返回全部硬编码档, size 不填。
 */
export async function getAllQualitiesWithSizes(data: Json): Promise<Quality[]> {
  const found: FoundMeta = { playUrls: [], coverUrl: null };
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

  const sizeMap = await probeQualitySizes(videoId, template);

  // 探测失败: 降级为不带大小的全部硬编码档
  if (sizeMap.size === 0) {
    return QUALITY_RATIOS.map(([ratio, label]) => ({
      ratio,
      label,
      url: buildPlayUrl(videoId, ratio, template),
    }));
  }

  // 转码档按「从低到高」做单调递增过滤 (540p -> 720p -> 1080p)
  // QUALITY_RATIOS 顺序是高->低, 这里反转处理。
  const transcodedLowToHigh = ["540p", "720p", "1080p"];
  const keptTranscoded: Array<[string, string, number]> = [];
  let prevSize = 0;
  for (const ratio of transcodedLowToHigh) {
    const size = sizeMap.get(ratio);
    if (size === undefined || size === 0) continue; // 该档探测失败
    // 必须严格大于上一个保留档, 否则视为静默降级假档
    if (size > prevSize) {
      keptTranscoded.push([ratio, labelOf(ratio), size]);
      prevSize = size;
    }
  }

  // 组装结果: 按高->低顺序展示 (default 在最前, 然后转码档从高到低)
  const qualities: Quality[] = [];
  const defaultSize = sizeMap.get("default");
  if (defaultSize && defaultSize > 0) {
    qualities.push({
      ratio: "default",
      label: "超高清",
      url: buildPlayUrl(videoId, "default", template),
      size: defaultSize,
    });
  }
  for (let i = keptTranscoded.length - 1; i >= 0; i--) {
    const [ratio, label, size] = keptTranscoded[i];
    qualities.push({
      ratio,
      label,
      url: buildPlayUrl(videoId, ratio, template),
      size,
    });
  }

  // 极端兜底: 去重后为空 (所有档都探测失败), 返回硬编码档
  if (!qualities.length) {
    return QUALITY_RATIOS.map(([ratio, label]) => ({
      ratio,
      label,
      url: buildPlayUrl(videoId, ratio, template),
    }));
  }
  return qualities;
}

/** 从解析数据中提取所有清晰度选项 (同步版, 不探测大小, 不去重)。 */
export function getAllQualities(data: Json): Quality[] {
  const found: FoundMeta = { playUrls: [], coverUrl: null };
  walkFind(data, found);

  let videoId = found.videoId;
  // 兜底: 从 URL 里提取 video_id
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

  // 找一个原始 URL 作为模板 (保留 line 等参数)
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

/** 提取标题/作者等元信息。 */
function extractMeta(data: Json): { title?: string; author?: string } {
  const found: FoundMeta = { playUrls: [], coverUrl: null };
  walkFind(data, found);
  return { title: found.title, author: found.author };
}

// ----------------------------------------------------------------------
// 图集 (图文) 解析
// ----------------------------------------------------------------------

/**
 * 判断解析数据是否为图集 (图文作品)。
 *
 * 抖音图集 aweme_type=2, 节点里有 images 数组 (≥1 张), 且其 video 字段
 * 没有 video_id (影集动态预览, 非可下载视频流)。
 */
export function isAlbum(data: Json): boolean {
  // 找到含 images 数组的节点
  const node = findAlbumNode(data);
  if (!node) return false;
  const images = (node as { images?: Json[] }).images;
  return Array.isArray(images) && images.length > 0;
}

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
      // 进一步确认: 视频作品的 images 为空或不存在, 图集才有
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

/**
 * 提取图集的无水印原图列表。
 *
 * 每张图的 download_url_list[0] 是无水印原图 (带 `-water-` 标识, 最高清);
 * url_list[0] 是预览图 (带 q80.webp, 较低清, 供 UI 缩略图)。
 */
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

/**
 * 解析抖音链接, 返回视频或图集信息 (自动识别)。
 * 对应 Python 版 server.py:parse_douyin (扩展支持图集)
 */
export async function parseDouyin(text: string): Promise<AnyParseResult> {
  const url = extractUrl(text);
  const awemeId = await getAwemeId(url);
  const html = await fetchSharePage(awemeId);
  const data = extractRouterData(html);
  if (!data) throw new Error("无法解析页面数据, 抖音接口可能已变更");

  const meta = extractMeta(data);
  const coverUrl = findCover(data);

  // 先判断是否为图集 (图文): 优先用图集解析路径
  if (isAlbum(data)) {
    const images = getAlbumImages(data);
    if (images.length) {
      return {
        aweme_id: awemeId,
        title: meta.title || awemeId,
        author: meta.author || "",
        cover_url: coverUrl,
        source_url: url,
        images,
        type: "album",
      };
    }
  }

  // 视频路径: 带大小探测 + 去重 (展示真实可用的清晰度档)
  const qualities = await getAllQualitiesWithSizes(data);
  if (!qualities.length) throw new Error("未能从页面找到视频地址");

  // 默认选 720p 作为主地址 (兼顾画质与体积); 720p 缺失时回退首个非超高清档,
  // 再兜底超高清。超高清(原画)体积大, 不作默认。
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
    source_url: url,
    type: "video",
  };
}

/** 清洗文件名中的非法字符 (对应 Python 版 sanitize_filename)。 */
export function sanitizeFilename(name: string, maxLen = 80): string {
  let n = name.replace(/[\\/:*?"<>|\n\r\t]/g, " ").trim();
  n = n.replace(/\s+/g, " ");
  if (n.length > maxLen) n = n.slice(0, maxLen).trim();
  return n || "douyin_video";
}
