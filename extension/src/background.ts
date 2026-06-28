/**
 * 抖音无水印下载 · service worker (background)。
 *
 * 职责:
 *   1. 接收 content script / popup 的 parse 消息 → fetch 分享页 → 解析 → 返回
 *   2. 接收 download 消息 → chrome.downloads.download
 *
 * 关键: 分享页与 CDN 请求的 Referer/UA 由 manifest 的 declarativeNetRequest
 * 静态规则注入, 这里不手设 forbidden header。
 */

import {
  parseByAwemeId,
  parseDouyin,
} from "./douyin-ext";
import type {
  RequestMessage,
  ParseResponse,
  DownloadResponse,
} from "./types";

// ----------------------------------------------------------------------
// chrome namespace 类型 (MV3 提供, 用 any 兜底避免引入额外 @types)
// ----------------------------------------------------------------------

declare const chrome: any;

// ----------------------------------------------------------------------
// 消息处理
// ----------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    msg: RequestMessage,
    _sender: any,
    sendResponse: (resp: any) => void,
  ): boolean => {
    // 返回 true 表示异步响应 (稍后调用 sendResponse)
    handleMessage(msg)
      .then(sendResponse)
      .catch((e) => {
        const err = e instanceof Error ? e.message : String(e);
        sendResponse({ ok: false, error: err });
      });
    return true;
  },
);

async function handleMessage(
  msg: RequestMessage,
): Promise<ParseResponse | DownloadResponse> {
  switch (msg.type) {
    case "parse":
      return handleParse(msg);
    case "download":
      return handleDownload(msg);
    default:
      return { ok: false, error: "未知的消息类型" };
  }
}

/** 解析: 优先 awemeId, 否则用 text (分享文案/链接) 走完整流程。 */
async function handleParse(msg: Extract<RequestMessage, { type: "parse" }>) {
  try {
    const data = msg.awemeId
      ? await parseByAwemeId(msg.awemeId, msg.sourceUrl)
      : await parseDouyin(msg.text || "");
    return { ok: true, data } as const;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, error: err } as const;
  }
}

/** 下载: 调 chrome.downloads.download, 由 DNR 注入 CDN 鉴权头。 */
async function handleDownload(
  msg: Extract<RequestMessage, { type: "download" }>,
): Promise<DownloadResponse> {
  if (!msg.url) return { ok: false, error: "缺少 url" };
  if (!msg.filename) return { ok: false, error: "缺少 filename" };

  return new Promise((resolve) => {
    try {
      chrome.downloads.download(
        { url: msg.url, filename: msg.filename, saveAs: false },
        (downloadId: number) => {
          if (chrome.runtime.lastError || !downloadId) {
            resolve({
              ok: false,
              error:
                chrome.runtime.lastError?.message || "下载启动失败",
            });
            return;
          }
          resolve({ ok: true, downloadId });
        },
      );
    } catch (e) {
      resolve({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

// SW 启动日志 (调试用)
// eslint-disable-next-line no-console
console.log("[douyin-dl] background service worker 已启动");
