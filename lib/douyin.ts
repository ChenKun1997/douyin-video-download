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
// 与 Python 版一致: 不提供 "default"(原画), 保留 1080p 为最高稳定档。
export const QUALITY_RATIOS: Array<[string, string]> = [
  ["1080p", "1080P"],
  ["720p", "720P"],
  ["540p", "540P"],
];

export interface Quality {
  ratio: string;
  label: string;
  url: string;
}

export interface ParseResult {
  aweme_id: string;
  title: string;
  author: string;
  video_url: string; // 默认清晰度地址 (兼容前端)
  qualities: Quality[];
  cover_url: string | null;
  source_url: string;
}

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
    if (em) extra = em[1];
    return `${prefix}?video_id=${videoId}&ratio=${ratio}${extra}`;
  }
  return `https://aweme.snssdk.com/aweme/v1/play/?video_id=${videoId}&ratio=${ratio}&line=0`;
}

/** 从解析数据中提取所有清晰度选项。 */
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

/**
 * 解析抖音链接, 返回完整视频信息。
 * 对应 Python 版 server.py:parse_douyin
 */
export async function parseDouyin(text: string): Promise<ParseResult> {
  const url = extractUrl(text);
  const awemeId = await getAwemeId(url);
  const html = await fetchSharePage(awemeId);
  const data = extractRouterData(html);
  if (!data) throw new Error("无法解析页面数据, 抖音接口可能已变更");

  const qualities = getAllQualities(data);
  if (!qualities.length) throw new Error("未能从页面找到视频地址");

  const meta = extractMeta(data);
  const coverUrl = findCover(data);
  // 默认选 720p 作为主地址 (兼容前端 video_url 字段)
  const defaultUrl =
    qualities.find((q) => q.ratio === "720p")?.url || qualities[0].url;

  return {
    aweme_id: awemeId,
    title: meta.title || awemeId,
    author: meta.author || "",
    video_url: defaultUrl,
    qualities,
    cover_url: coverUrl,
    source_url: url,
  };
}

/** 清洗文件名中的非法字符 (对应 Python 版 sanitize_filename)。 */
export function sanitizeFilename(name: string, maxLen = 80): string {
  let n = name.replace(/[\\/:*?"<>|\n\r\t]/g, " ").trim();
  n = n.replace(/\s+/g, " ");
  if (n.length > maxLen) n = n.slice(0, maxLen).trim();
  return n || "douyin_video";
}
