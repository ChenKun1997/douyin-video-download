/**
 * 抖音「用户」相关: 把各种输入解析为 sec_uid, 并分页拉取用户作品列表。
 *
 * 依赖 lib/douyin-web.ts 的签名请求能力。
 *
 * 输入格式 (resolveSecUid 支持):
 *   1. 主页长链: https://www.douyin.com/user/MS4w...      -> 正则取 sec_uid
 *   2. 裸 sec_uid: MS4w...                                 -> 直接用
 *   3. v.douyin.com 短链 / 带文案的分享:                    -> 提取链接→重定向→取 sec_uid
 *   4. 数字 short_id / 抖音号:                              -> 签名搜索反查
 *
 * ⚠️ 关于 4: 抖音匿名搜索用户普遍返回 2483 (需登录态), 大概率解析失败。
 *    推荐用户改用主页链接或 sec_uid (1/2/3)。
 */

import { signedRequest, hasUserCookie } from "./douyin-web";
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

/** 从分享文案中提取 http(s) 链接 (复用 douyin.ts 的同名逻辑)。 */
function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s，。、；]+/);
  return m ? m[0] : null;
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
 * 从一个 URL 里(可能含 query 参数)提取 sec_uid。
 * 兼容: /user/<sec_uid>、裸 sec_uid、?sec_uid=、?sec_user_id=。
 */
function extractSecUidFromUrl(u: string): string | null {
  // 1. 路径里的 sec_uid
  const m = u.match(SEC_UID_RE) || u.match(USER_PATH_RE);
  if (m && m[1]) return m[1];
  // 2. query 里的 sec_uid / sec_user_id
  const q = u.match(/[?&]sec_us(?:er_)?id=([A-Za-z0-9_.-]+)/);
  if (q && q[1]) return q[1];
  return null;
}

/**
 * 从任意用户输入解析出 sec_uid。
 *
 * @param input 主页链接 / 短链 / 带文案的分享 / 裸 sec_uid / 数字 short_id / 抖音号
 * @returns sec_uid (解析失败抛错, 错误信息对用户友好)
 */
export async function resolveSecUid(input: string): Promise<string> {
  const text = (input || "").trim();
  if (!text) throw new Error("输入为空");

  // 1. 直接含 sec_uid (长链 / 裸 sec_uid / 文案里含 sec_uid 的链接)
  const direct = extractSecUidFromUrl(text);
  if (direct) return direct;

  // 2. 含链接 (含分享文案): 先提取真正的 URL, 再跟随重定向
  const link = extractUrl(text);
  if (link) {
    let finalUrl = link;
    try {
      finalUrl = await fetchFinalUrl(link);
    } catch {
      /* 网络错误则用原始 link 兜底 */
    }
    const sec = extractSecUidFromUrl(finalUrl);
    if (sec) return sec;
    // 重定向落到了抖音首页 (短链无效/已失效)
    if (/douyin\.com\/?$/i.test(finalUrl) || finalUrl === link) {
      throw new Error(
        "短链无效或已失效，请确认是用户主页链接（不是视频/直播链接）",
      );
    }
    throw new Error("无法从链接解析 sec_uid，请粘贴用户主页链接");
  }

  // 3. 数字 short_id / 抖音号: 调签名搜索接口反查 (匿名常被风控, 见下方)
  if (looksLikeShortId(text) || looksLikeDouyinId(text)) {
    const sec = await searchUserSecUid(text);
    if (sec) return sec;
    throw new Error(
      `无法解析「${text}」：抖音匿名搜索用户需要登录态，请改用主页链接或 sec_uid`,
    );
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
 *
 * ⚠️ 抖音匿名搜索用户普遍返回 status_code 2483 (需登录态),
 *    这是抖音的反爬限制, 非代码问题。调用方应提示用户改用主页链接。
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
  // 2483 = 需登录 / 风控, 明确告知无结果而非"未找到"
  const sc = r.data?.status_code;
  if (sc && sc !== 0) return null;
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
  /** 下一页游标 (抖音匿名访问下 cursor 分页不可用, 仅作记录) */
  max_cursor: number;
  has_more: boolean;
  /** 抖音匿名访问是否还能继续翻页 (实际为 false: 见 MAX_FETCHABLE 说明) */
  can_fetch_more: boolean;
}

/**
 * 单次请求的 count。
 *
 * - 匿名访问: 抖音 web aweme/post 单用户最多返回 ~41 条, cursor 分页不可用,
 *   故 count=50 一次性拿满上限。
 * - 登录态 (注入用户 cookie): 可正常 cursor 翻页拿到全部作品。
 */
const PAGE_SIZE = 50;
/** 抖音匿名访问下, 单用户可获取的作品上限 (实测, 含 f2 对照)。 */
export const MAX_FETCHABLE = 41;

/**
 * 拉取用户作品列表。
 *
 * ⚠️ 实测抖音 web aweme/post 在匿名(纯签名)访问下:
 *   - 单次最多返回 ~MAX_FETCHABLE 条 (count=50 即可拿满)
 *   - cursor 分页不可用 (max_cursor≠0 一律返回空)
 * 因此本函数一次拉取上限, 不做翻页。前端不应再显示「加载更多」。
 *
 * @param secUid 用户 sec_uid
 * @param cursor 保留参数 (兼容旧调用), 实际忽略
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
  // 匿名访问下 cursor 分页不可用 (只能拿 ~41 条); 登录态下可正常翻页
  const canFetchMore =
    hasUserCookie() && !!d.has_more && list.length > 0;
  return {
    items,
    max_cursor: Number(d.max_cursor || 0),
    has_more: !!d.has_more,
    can_fetch_more: canFetchMore,
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
