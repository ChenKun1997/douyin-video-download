/**
 * 抖音 web 接口客户端 (服务端, Node runtime)。
 *
 * 提供:
 *   - 匿名获取 web 访问所需的 cookie: ttwid (passport/sguy 接口) / msToken
 *   - 构造标准 web API 请求参数 (device_platform / aid / version_code / ...)
 *   - 用 a_bogus 签名后发起请求 (aweme/post / search 等需签名的接口)
 *
 * 与 lib/douyin.ts (单视频分享页路径) 互补: 这里走 www.douyin.com 的
 * web 接口, 必须签名, 用于「用户作品列表」这类分享页拿不到的数据。
 *
 * ⚠️ 签名算法 (lib/abogus.ts) 会随抖音更新而失效, 届时本文件请求会
 *    返回 status_code != 0 或空 aweme_list, 需更新签名。
 */

import { generateABogus, DEFAULT_UA } from "./abogus";

// ----------------------------------------------------------------------
// 常量
// ----------------------------------------------------------------------

export const WEB_UA = DEFAULT_UA;

const HOME_URL = "https://www.douyin.com/";
// 匿名换取 ttwid 的接口 (无需登录): passport/sguy 接口会 Set-Cookie ttwid
const TTWID_ENDPOINT =
  "https://ttwid.bytedance.com/ttwid/union/register/";

// 标准的 web 请求公共参数 (抖音网页端实测固定项)
const COMMON_PARAMS = {
  device_platform: "webapp",
  aid: "6383",
  channel: "channel_pc_web",
  update_version_code: "170400",
  pc_client_type: "1",
  pc_libra_divert: "Windows",
  support_h265: "1",
  support_dash: "0",
  version_code: "290100",
  version_name: "29.1.0",
  cookie_enabled: "true",
  screen_width: "1920",
  screen_height: "1080",
  browser_language: "zh-CN",
  browser_platform: "Win32",
  browser_name: "Edge",
  browser_version: "130.0.0.0",
  browser_online: "true",
  engine_name: "Blink",
  engine_version: "130.0.0.0",
  os_name: "Windows",
  os_version: "10",
  cpu_core_num: "12",
  device_memory: "8",
  platform: "PC",
  downlink: "10",
  effective_type: "4g",
  round_trip_time: "50",
};

// ----------------------------------------------------------------------
// Token / Cookie 缓存 (模块级, 进程内复用; Vercel 函数实例间独立)
// ----------------------------------------------------------------------

interface TokenCache {
  cookieHeader: string;
  ttwid: string;
  msToken: string;
  expireAt: number;
}

let tokenCache: TokenCache | null = null;

/**
 * 用户登录态 cookie (可选)。设置后, 所有签名请求改用该 cookie,
 * 解锁匿名访问下的限制 (如用户作品列表只能拿 ~41 条 / 不能翻页)。
 *
 * 由调用方 (API route) 从请求头/参数注入, 进程内有效。
 * 内容是浏览器 F12 复制的整段 Cookie, 至少含 sessionid / ttwid 等登录字段。
 */
let userCookie: string | null = null;

/** 注入(或清除) 用户登录 cookie。传空字符串/null 即恢复匿名模式。 */
export function setUserCookie(cookie: string | null | undefined) {
  userCookie = cookie && cookie.trim() ? cookie.trim() : null;
}

/** 当前是否处于登录态 (已注入用户 cookie)。 */
export function hasUserCookie(): boolean {
  return !!userCookie;
}

/** 随机 msToken (抖音对 web 接口的 msToken 校验较松, 可用随机串)。 */
function genMsToken(len = 107): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++)
    s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** 解析 Set-Cookie 头里的某个字段 (简易实现)。 */
function parseCookie(setCookieValues: string[], name: string): string | null {
  for (const sc of setCookieValues) {
    const m = sc.match(new RegExp(`${name}=([^;]+)`));
    if (m) return m[1];
  }
  return null;
}

/**
 * 匿名获取 web 访问所需的 ttwid (及附带 cookie)。
 * 通过 POST passport 的 ttwid 注册接口, 服务端会在 Set-Cookie 回填 ttwid。
 * 失败则退化为「无 ttwid」(部分接口仍可用)。
 */
async function fetchTtwid(): Promise<string> {
  const body = JSON.stringify({
    region: "cn",
    aid: 1768,
    needFid: false,
    service: HOME_URL,
    mip: "0.0.0.0",
    cbUrlProtocol: "https",
    union: true,
  });
  try {
    const resp = await fetch(TTWID_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": WEB_UA,
      },
      body,
    });
    // fetch 的 Headers 不直接暴露多个 Set-Cookie, 用 getSetCookie (Node 18+/undici)
    const setCookies =
      typeof resp.headers.getSetCookie === "function"
        ? resp.headers.getSetCookie()
        : [];
    const ttwid = parseCookie(setCookies, "ttwid");
    if (ttwid) return ttwid;
  } catch {
    // 忽略: 部分网络下可能失败, 后续请求无 ttwid 兜底
  }
  return "";
}

/**
 * 取 (或复用缓存) 访问 token: ttwid + msToken, 组装 Cookie 头。
 * 缓存 30 分钟, 避免每次请求都注册 ttwid。
 */
export async function getWebTokens(forceRefresh = false): Promise<TokenCache> {
  const now = Date.now();
  if (tokenCache && !forceRefresh && tokenCache.expireAt > now) {
    return tokenCache;
  }
  const ttwid = await fetchTtwid();
  const msToken = genMsToken();
  const parts = ["msToken=" + msToken, "odin_tt=1"];
  if (ttwid) parts.unshift("ttwid=" + ttwid);
  tokenCache = {
    cookieHeader: parts.join("; "),
    ttwid,
    msToken,
    expireAt: now + 30 * 60 * 1000,
  };
  return tokenCache;
}

// ----------------------------------------------------------------------
// 签名请求
// ----------------------------------------------------------------------

export interface SignedRequestOptions {
  /** API path, 如 /aweme/v1/web/aweme/post/ */
  path: string;
  /** 业务参数 (不含公共参数, 不含签名) */
  params: Record<string, string | number>;
  /** 请求方法 GET / POST */
  method?: "GET" | "POST";
  /** POST 请求体 (会被纳入签名计算) */
  body?: string;
}

export interface SignedResponse<T> {
  ok: boolean;
  status: number;
  /** 抖音接口 JSON (含 status_code / aweme_list 等); 解析失败为 null */
  data: T | null;
  /** 错误信息 (ok=false 时) */
  error?: string;
}

/**
 * 构造签名后的完整查询串。
 *
 * 与 f2 ABogusManager.model_2_endpoint 完全一致:
 *   - 业务参数按「插入顺序」拼接 (不排序)
 *   - 值不做 URL 编码 (f2 直接 f"{k}={v}")
 *   - msToken 不纳入签名, 而是通过 cookie 传递 (见 getWebTokens)
 *   - 签名后追加 &a_bogus=...
 *   - options 用 f2 的默认 [0,1,14] (14 兼容 8, GET/POST 通用)
 */
async function buildSignedParams(
  params: Record<string, string | number>,
  body: string,
): Promise<{ query: string; ua: string; fp: string; cookie: string }> {
  // 登录态: 直接用用户 cookie; 否则匿名 ttwid/msToken
  const cookie = userCookie || (await getWebTokens()).cookieHeader;
  // 业务参数 + 公共参数 (插入顺序: 先公共, 后业务)
  const all: Record<string, string> = {
    ...COMMON_PARAMS,
    ...Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ),
  };
  // 不编码、不排序, 直接 k=v&k=v
  const query = Object.entries(all)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const signed = generateABogus(query, body, WEB_UA, "", [0, 1, 14]);
  return {
    query: signed.params,
    ua: signed.userAgent,
    fp: signed.fingerprint,
    cookie,
  };
}

/**
 * 发起一个签名后的抖音 web 接口请求。
 * 自动处理 ttwid/msToken/签名/Cookie/UA。
 */
export async function signedRequest<T = unknown>(
  opts: SignedRequestOptions,
): Promise<SignedResponse<T>> {
  const method = opts.method || "GET";
  const body = opts.body || "";
  const { query, ua, cookie } = await buildSignedParams(opts.params, body);
  const url = `https://www.douyin.com${opts.path}?${query}`;

  const headers: Record<string, string> = {
    "User-Agent": ua,
    Referer: HOME_URL,
    Cookie: cookie,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      redirect: "follow",
      cache: "no-store",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, data: null, error: `请求失败: ${msg}` };
  }

  if (!resp.ok) {
    // 抖音风控可能返回 412 / 页面 HTML
    const text = await resp.text().catch(() => "");
    const hint =
      resp.status === 412 || /<html/i.test(text)
        ? "触发风控 (可能签名失效或缺少有效 cookie)"
        : `HTTP ${resp.status}`;
    return {
      ok: false,
      status: resp.status,
      data: null,
      error: `${hint}${text ? `: ${text.slice(0, 120)}` : ""}`,
    };
  }

  let data: T;
  try {
    data = (await resp.json()) as T;
  } catch {
    return { ok: false, status: resp.status, data: null, error: "响应不是合法 JSON" };
  }
  return { ok: true, status: resp.status, data };
}
