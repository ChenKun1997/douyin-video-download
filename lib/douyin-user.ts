/**
 * 抖音「用户」相关: 把各种输入解析为 sec_uid, 并分页拉取用户作品列表。
 *
 * 依赖 lib/douyin-web.ts 的签名请求能力。
 *
 * 输入格式 (resolveSecUid 支持):
 *   1. 主页长链: https://www.douyin.com/user/MS4w...      -> 正则取 sec_uid
 *   2. 裸 sec_uid: MS4w...                                 -> 直接用
 *   3. v.douyin.com 短链: 301 跳到主页                       -> 跟随重定向后取
 *   4. 数字 short_id / 抖音号(纯字母数字):                  -> 调签名的搜索接口反查
 */

import { signedRequest } from "./douyin-web";
import { MOBILE_UA } from "./douyin";

// ----------------------------------------------------------------------
// sec_uid 解析
// ----------------------------------------------------------------------

/** sec_uid 形如 MS4wLjAB... 一长串 URL-safe base64, 至少含点号。 */
const SEC_UID_RE = /(MS4wLjABAAAA[A-Za-z0-9_-]+)/;

/** 主页长链里的 /user/<sec_uid>。 */
const USER_PATH_RE = /\/user\/(MS4w[A-Za-z0-9_-]+)/;

/** 是否像纯数字 short_id。 */
function looksLikeShortId(s: string): boolean {
  return /^\d{6,20}$/.test(s.trim());
}

/** 抖音号: 以字母开头, 6-20 位字母数字下划线 (排除明显是链接/中文的情况)。 */
function looksLikeDouyinId(s: string): boolean {
  const t = s.trim();
  return /^[A-Za-z][A-Za-z0-9_]{5,19}$/.test(t);
}

/** 手动跟随重定向, 拿到最终 URL (复用 douyin.ts 的思路)。 */
async function fetchFinalUrl(url: string): Promise<string> {
  let current = url;
  for (let i = 0; i < 8; i++) {
    const resp = await fetch(current, {
      headers: { "User-Agent": MOBILE_UA },
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get("location");
      if (!loc) break;
      current = new URL(loc, current).href;
      continue;
    }
    return resp.url || current;
  }
  return current;
}

/**
 * 从任意用户输入解析出 sec_uid。
 *
 * @param input 主页链接 / 短链 / 裸 sec_uid / 数字 short_id / 抖音号
 * @returns sec_uid (解析失败抛错)
 */
export async function resolveSecUid(input: string): Promise<string> {
  const text = (input || "").trim();
  if (!text) throw new Error("输入为空");

  // 1/2. 直接含 sec_uid (长链或裸 sec_uid)
  const direct = text.match(SEC_UID_RE) || text.match(USER_PATH_RE);
  if (direct && direct[1]) return direct[1];

  // 3. 短链 / 任意 douyin 链接: 跟随重定向后从最终 URL 取
  if (/https?:\/\//i.test(text)) {
    let finalUrl = text;
    try {
      finalUrl = await fetchFinalUrl(text);
    } catch {
      /* 忽略网络错误, 继续兜底 */
    }
    const fromRedirect =
      finalUrl.match(SEC_UID_RE) || finalUrl.match(USER_PATH_RE);
    if (fromRedirect && fromRedirect[1]) return fromRedirect[1];
    // 重定向目标里有时 sec_uid 在 query 里
    const fromQuery = finalUrl.match(/sec_uid=([A-Za-z0-9_-]+)/);
    if (fromQuery) return fromQuery[1];
    throw new Error("无法从链接解析 sec_uid");
  }

  // 4. 数字 short_id / 抖音号: 调签名搜索接口反查
  if (looksLikeShortId(text) || looksLikeDouyinId(text)) {
    const sec = await searchUserSecUid(text);
    if (sec) return sec;
    throw new Error(`未能找到对应用户: ${text}`);
  }

  throw new Error(`无法识别的输入: ${text}`);
}

// ----------------------------------------------------------------------
// 用户资料 (用于 UI 展示昵称/头像/作品数)
// ----------------------------------------------------------------------

export interface UserProfile {
  sec_uid: string;
  short_id: string;
  nickname: string;
  avatar_url: string | null;
  aweme_count: number;
  signature: string;
}

/**
 * 通过 sec_uid 拉取用户资料 (user/profile/self/ 接口)。
 * 用于解析后展示昵称、头像、作品总数。
 */
export async function getUserProfile(secUid: string): Promise<UserProfile> {
  const r = await signedRequest<any>({
    path: "/aweme/v1/web/user/profile/other/",
    params: {
      sec_user_id: secUid,
      source: "channel_pc_web",
      publish_video_strategy_type: 2,
    },
    method: "GET",
  });
  if (!r.ok || !r.data) {
    throw new Error(r.error || "获取用户资料失败");
  }
  const user = r.data?.user;
  if (!user) {
    // status_code != 0 通常意味着签名失效或风控
    throw new Error(
      `获取用户资料失败 (status_code=${r.data?.status_code ?? "?"})`,
    );
  }
  return {
    sec_uid: secUid,
    short_id: String(user.short_id || user.uid || ""),
    nickname: user.nickname || "未知用户",
    avatar_url: user.avatar_thumb?.url_list?.[0] || null,
    aweme_count: Number(user.aweme_count || 0),
    signature: user.signature || "",
  };
}

/**
 * 用 short_id / 抖音号 搜索, 取第一个匹配用户的 sec_uid。
 * 走签名的 aweme/v1/web/general/search/single/ 接口。
 */
async function searchUserSecUid(keyword: string): Promise<string | null> {
  const r = await signedRequest<any>({
    path: "/aweme/v1/web/general/search/single/",
    params: {
      keyword,
      search_channel: "aweme_user_web",
      search_source: "normal",
      query_correct_type: "1",
      is_filter_search: "0",
      offset: "0",
      count: "10",
      sort_type: "0",
      publish_time: "0",
    },
    method: "GET",
  });
  if (!r.ok || !r.data) return null;
  const list = r.data?.data || [];
  for (const item of list) {
    const sec = item?.user?.sec_uid;
    if (sec) return sec as string;
  }
  return null;
}

// ----------------------------------------------------------------------
// 作品列表分页
// ----------------------------------------------------------------------

export interface VideoListItem {
  aweme_id: string;
  desc: string;
  create_time: number; // 秒级时间戳
  /** 封面图 */
  cover_url: string | null;
  /** 无水印播放地址模板 (含 video_id, 可按 ratio 切换清晰度) */
  play_url: string | null;
  video_id: string | null;
  /** 视频时长 (秒) */
  duration: number;
}

export interface VideoPage {
  items: VideoListItem[];
  /** 下一页游标; has_more=false 时为 0 */
  max_cursor: number;
  has_more: boolean;
}

const PAGE_SIZE = 18;

/**
 * 拉取用户作品列表的「一页」。
 * 由前端循环调用以规避 Vercel 函数时长限制 (每页 ~0.6s)。
 *
 * @param secUid 用户 sec_uid
 * @param cursor 上一页返回的 max_cursor; 首页传 0
 */
export async function fetchUserVideoPage(
  secUid: string,
  cursor = 0,
): Promise<VideoPage> {
  const r = await signedRequest<any>({
    path: "/aweme/v1/web/aweme/post/",
    params: {
      sec_user_id: secUid,
      count: PAGE_SIZE,
      max_cursor: cursor,
      locate_query: "false",
      publish_video_strategy_type: 2,
      need_time_list: 1,
      time_list_query: 0,
      whale_cut_token: "",
      cut_version: 1,
      from_user_page: 1,
    },
    method: "GET",
  });
  if (!r.ok || !r.data) {
    throw new Error(r.error || "获取作品列表失败");
  }
  const d = r.data;
  const list: any[] = Array.isArray(d.aweme_list) ? d.aweme_list : [];
  const items: VideoListItem[] = list.map((a) => parseAweme(a));
  return {
    items,
    max_cursor: Number(d.max_cursor || 0),
    has_more: !!d.has_more,
  };
}

/** 从单个 aweme 节点提取 UI/下载需要的字段。 */
function parseAweme(a: any): VideoListItem {
  const video = a.video || {};
  const playAddr = video.play_addr || video.download_addr || {};
  const urlList: string[] = playAddr.url_list || [];
  // play_addr 的 url 里含 video_id, 用于后续构造无水印地址
  const playUrl = urlList.find((u) => u.includes("play")) || urlList[0] || null;
  const videoId =
    (video.video_id as string) ||
    (typeof playUrl === "string"
      ? (playUrl.match(/video_id=([0-9a-zA-Z]+)/)?.[1] ?? null)
      : null);
  return {
    aweme_id: String(a.aweme_id || ""),
    desc: String(a.desc || "").slice(0, 200),
    create_time: Number(a.create_time || 0),
    cover_url: video.cover?.url_list?.[0] || video.origin_cover?.url_list?.[0] || null,
    play_url: playUrl,
    video_id: videoId,
    duration: Math.round(Number(video.duration || 0) / 1000),
  };
}
