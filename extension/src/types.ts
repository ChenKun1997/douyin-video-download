/**
 * content script / service worker / popup 之间共享的消息协议与类型。
 *
 * 通信全部走 chrome.runtime.sendMessage / onMessage。
 */

export type MessageType = "parse" | "download";

/** 解析请求: 由 aweme_id (页面注入按钮) 或 文本 (popup 粘贴) 触发。 */
export interface ParseMessage {
  type: "parse";
  /** 已知的 aweme_id (页面注入路径直接给)。 */
  awemeId?: string;
  /** 来源 URL (回填用)。 */
  sourceUrl?: string;
  /** 分享文案 / 链接 (popup 路径, 优先级高于 awemeId)。 */
  text?: string;
}

/** 下载请求: 让 SW 调 chrome.downloads.download。 */
export interface DownloadMessage {
  type: "download";
  url: string;
  filename: string;
}

export type RequestMessage = ParseMessage | DownloadMessage;

export interface ParseOkResponse {
  ok: true;
  data: ParsedData;
}

export interface ParseErrorResponse {
  ok: false;
  error: string;
}

export type ParseResponse = ParseOkResponse | ParseErrorResponse;

export interface DownloadOkResponse {
  ok: true;
  downloadId: number;
}

export interface DownloadErrorResponse {
  ok: false;
  error: string;
}

export type DownloadResponse = DownloadOkResponse | DownloadErrorResponse;

export type AnyResponse = ParseResponse | DownloadResponse;

/** 解析结果 (视频或图集二选一)。 */
export interface Quality {
  ratio: string;
  label: string;
  url: string;
  /** 文件字节数 (插件不填, 仅为与网页版协议一致)。 */
  size?: number;
}

export interface VideoData {
  type: "video";
  aweme_id: string;
  title: string;
  author: string;
  video_url: string;
  qualities: Quality[];
  cover_url: string | null;
  source_url: string;
}

export interface AlbumImageData {
  url: string;
  preview: string | null;
  width: number;
  height: number;
}

export interface AlbumData {
  type: "album";
  aweme_id: string;
  title: string;
  author: string;
  cover_url: string | null;
  source_url: string;
  images: AlbumImageData[];
}

export type ParsedData = VideoData | AlbumData;
