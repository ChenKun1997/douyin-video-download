"use client";

/**
 * 抖音无水印下载 - 主页面 (迁移自原 index.html)
 *
 * 功能与原版一致:
 *   - 粘贴分享文案/链接 -> 解析 -> 预览 -> 下载
 *   - 清晰度选择 (1080P/720P/540P)
 *   - 复制无水印直链
 *   - 本地历史记录 (localStorage, 最多 30 条)
 *   - Ctrl/Cmd + Enter 快捷解析
 *
 * 新增: 下载失败时 (Vercel 免费版 10s 超时) 提示用复制直链兜底。
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface Quality {
  ratio: string;
  label: string;
  url: string;
}

interface VideoInfo {
  aweme_id: string;
  title: string;
  author: string;
  video_url: string;
  qualities: Quality[];
  cover_url: string | null;
  source_url: string;
}

interface HistoryItem {
  aweme_id: string;
  title: string;
  author: string;
  cover_url: string | null;
  video_url: string;
  ts: number;
}

const HISTORY_KEY = "douyin_history_v1";

type StatusType = "info" | "error" | "success";
interface StatusState {
  type: StatusType;
  msg: string;
}

export default function Home() {
  const [input, setInput] = useState("");
  const [parsing, setParsing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [status, setStatus] = useState<StatusState | null>(null);
  const [currentVideo, setCurrentVideo] = useState<VideoInfo | null>(null);
  const [selectedQuality, setSelectedQuality] = useState<Quality | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ----------------- 状态提示 -----------------
  const showStatus = useCallback(
    (type: StatusType, msg: string, autoClose = 0) => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
      setStatus({ type, msg });
      if (autoClose) {
        statusTimer.current = setTimeout(
          () => setStatus(null),
          autoClose,
        );
      }
    },
    [],
  );

  useEffect(
    () => () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
    },
    [],
  );

  // ----------------- 历史记录 -----------------
  const loadHistory = useCallback((): HistoryItem[] => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    setHistory(loadHistory());
  }, [loadHistory]);

  const saveHistory = useCallback(
    (data: VideoInfo) => {
      const list = loadHistory().filter(
        (h) => h.aweme_id !== data.aweme_id,
      );
      list.unshift({
        aweme_id: data.aweme_id,
        title: data.title,
        author: data.author,
        cover_url: data.cover_url,
        video_url: data.video_url,
        ts: Date.now(),
      });
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 30)));
      setHistory(list.slice(0, 30));
    },
    [loadHistory],
  );

  const deleteHistory = (id: string) => {
    const list = loadHistory().filter((h) => h.aweme_id !== id);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    setHistory(list);
  };

  const clearHistory = () => {
    if (confirm("确定清空所有历史记录？")) {
      localStorage.removeItem(HISTORY_KEY);
      setHistory([]);
    }
  };

  // ----------------- 解析 -----------------
  const parse = useCallback(async () => {
    const text = input.trim();
    if (!text) {
      showStatus("error", "请先粘贴抖音链接或分享文案");
      return;
    }
    setParsing(true);
    setCurrentVideo(null);
    showStatus("info", "正在解析，请稍候...");
    try {
      const resp = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const json = await resp.json();
      if (!resp.ok || !json.ok) {
        throw new Error(json.error || `请求失败 (${resp.status})`);
      }
      renderResult(json.data as VideoInfo);
      saveHistory(json.data as VideoInfo);
      showStatus("success", "解析成功！", 2500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showStatus("error", "解析失败：" + msg);
    } finally {
      setParsing(false);
    }
  }, [input, showStatus, saveHistory]);

  const renderResult = (data: VideoInfo) => {
    setCurrentVideo(data);
    // 清晰度: 没有列表时退化为单选项
    const qualities =
      data.qualities && data.qualities.length
        ? data.qualities
        : [{ ratio: "default", label: "默认", url: data.video_url }];
    const defaultIdx = Math.max(
      0,
      qualities.findIndex((q) => q.ratio === "720p"),
    );
    setSelectedQuality(qualities[defaultIdx]);
  };

  const getSelectedUrl = (): string => {
    return (
      (selectedQuality && selectedQuality.url) ||
      currentVideo?.video_url ||
      ""
    );
  };

  // ----------------- 下载 -----------------
  /**
   * 下载策略 (优化版, 解决 Vercel 部署后"很慢才开始/下载失败"问题):
   *   1. 优先 redirect 模式: 让 /api/proxy 探出最终 CDN 地址并 302,
   *      浏览器直连 CDN 下载 —— 不经 Vercel 转发, 速度最快, 不受超时限制。
   *   2. 若 redirect 失败 (CDN 校验 Referer 导致直连 403), 自动降级 stream 模式:
   *      由 Vercel 流式转发 (受 10s 超时限制, 仅小视频可靠)。
   *
   * 用 fetch 探测 proxy 是否成功返回 302 (而非 JSON 错误),
   * 成功后才用 <a> 触发浏览器原生下载。
   */
  const download = useCallback(
    async (video: VideoInfo | null, quality: Quality | null) => {
      if (!video) return;
      const videoUrl = (quality && quality.url) || video.video_url;
      const qualityTag = quality ? quality.label : "";
      const fname =
        (video.author ? video.author + "_" : "") +
        video.title +
        (qualityTag ? "_" + qualityTag : "") +
        ".mp4";

      const buildProxyUrl = (mode: "redirect" | "stream") =>
        "/api/proxy?url=" +
        encodeURIComponent(videoUrl) +
        "&filename=" +
        encodeURIComponent(fname) +
        "&mode=" +
        mode;

      const triggerDownload = (proxyUrl: string) => {
        const a = document.createElement("a");
        a.href = proxyUrl;
        a.download = fname; // 同源时生效; 跨域 302 后浏览器忽略此属性 (无妨)
        document.body.appendChild(a);
        a.click();
        a.remove();
      };

      showStatus("info", `准备下载 ${qualityTag || "视频"}...`);
      setDownloading(true);

      try {
        // 1. 先探测 redirect 模式是否可用。
        //    注意: 浏览器对 fetch + redirect:"manual" 返回 opaqueredirect 响应,
        //    其 status 永远是 0、且读不到 Location 头 (浏览器规范限制)。
        //    因此不能用 status===302 判断, 而要用 response.type === "opaqueredirect":
        //    它恰好表示"服务端返回了一个重定向响应"。
        let redirectOk = false;
        try {
          const probe = await fetch(buildProxyUrl("redirect"), {
            redirect: "manual",
          });
          redirectOk = probe.type === "opaqueredirect";
          if (!redirectOk) {
            // 服务端没重定向 (返回了 JSON 错误), 记录原因便于排查
            const err = await probe.text().catch(() => "");
            console.warn(
              "[download] redirect 模式未返回重定向, 降级 stream:",
              probe.status,
              err.slice(0, 200),
            );
          }
        } catch (e) {
          console.warn("[download] redirect 探测异常, 降级 stream:", e);
        }

        if (redirectOk) {
          // 2a. redirect 探路成功: 用 <a> 触发下载, 浏览器会跟随 302 直连 CDN
          triggerDownload(buildProxyUrl("redirect"));
          showStatus(
            "success",
            "已开始下载（直连 CDN），请查看浏览器下载",
            3500,
          );
          return;
        }

        // 2b. redirect 失败 -> 降级 stream 模式 (流式转发, 受 10s 超时限制)
        triggerDownload(buildProxyUrl("stream"));
        showStatus(
          "info",
          "正在通过服务器转发下载（较慢），大视频若未完成可点'复制直链'用下载工具",
          5000,
        );
      } finally {
        setDownloading(false);
      }
    },
    [showStatus],
  );

  const copyUrl = useCallback(async () => {
    if (!currentVideo) return;
    const videoUrl = getSelectedUrl();
    try {
      await navigator.clipboard.writeText(videoUrl);
      showStatus("success", "已复制当前清晰度的无水印链接到剪贴板", 2000);
    } catch {
      showStatus("error", "复制失败，请手动复制");
    }
  }, [currentVideo, selectedQuality, showStatus]);

  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setInput(text.trim());
      showStatus("info", "已粘贴剪贴板内容", 1500);
    } catch {
      showStatus("error", "无法读取剪贴板，请手动粘贴");
    }
  }, [showStatus]);

  // ----------------- 历史项操作 -----------------
  const onHistoryLoad = (item: HistoryItem) => {
    // 历史记录里只有 video_url (默认清晰度), 重新加载时以默认档呈现
    renderResult({
      ...item,
      qualities: [{ ratio: "default", label: "默认", url: item.video_url }],
      cover_url: item.cover_url,
      source_url: "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const onHistoryDl = (item: HistoryItem) => {
    download(
      { ...item, qualities: [], source_url: "" },
      { ratio: "default", label: "默认", url: item.video_url },
    );
  };

  // ----------------- 快捷键 -----------------
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      parse();
    }
  };

  const qualities = currentVideo?.qualities?.length
    ? currentVideo.qualities
    : currentVideo
      ? [{ ratio: "default", label: "默认", url: currentVideo.video_url }]
      : [];

  return (
    <>
      <header>
        <div className="logo">
          <span className="dot">🎵</span>
          <span>
            抖音<span className="accent">无水印</span>下载
          </span>
        </div>
        <div className="subtitle">
          粘贴分享文案或链接，一键解析无水印视频
        </div>
      </header>

      <div className="wrap">
        {/* 输入 */}
        <div className="input-card">
          <div className="input-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                "在此粘贴抖音分享文案，例如：\n7.99 复制打开抖音，看看【作者的作品】 https://v.douyin.com/xxxxx/ ..."
              }
            />
            <div className="btn-group">
              <button
                className="btn btn-primary"
                onClick={parse}
                disabled={parsing}
              >
                {parsing ? (
                  <>
                    <span className="spinner" /> 解析中...
                  </>
                ) : (
                  "🔍 解析"
                )}
              </button>
              <button className="btn btn-ghost" onClick={pasteFromClipboard}>
                📋 粘贴剪贴板
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setInput("");
                }}
              >
                ✖ 清空
              </button>
            </div>
          </div>
          <div className="hint">
            <span className="tag">提示</span>
            支持短链 v.douyin.com / 长链 www.douyin.com，可直接粘贴 App
            分享的整段文案 · 输入框内按 Ctrl/Cmd + Enter 快速解析
          </div>
        </div>

        {/* 状态条 */}
        {status && (
          <div className={`status show ${status.type}`}>
            <span>
              {status.type === "error"
                ? "⚠️"
                : status.type === "success"
                  ? "✅"
                  : "⏳"}
            </span>
            <span>{status.msg}</span>
          </div>
        )}

        {/* 结果 */}
        {currentVideo && (
          <div className="result">
            <div className="result-head">
              {currentVideo.cover_url ? (
                // 抖音封面图无 CORS/Referer 限制, 直接 <img>
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="cover"
                  src={currentVideo.cover_url}
                  alt="封面"
                  onError={(e) => {
                    const t = e.target as HTMLImageElement;
                    t.classList.add("placeholder");
                    t.removeAttribute("src");
                    t.alt = "无封面";
                  }}
                />
              ) : (
                <div className="cover placeholder">无封面</div>
              )}
              <div className="meta">
                <div className="title">{currentVideo.title}</div>
                <div className="author">
                  {currentVideo.author
                    ? "👤 " + currentVideo.author
                    : ""}
                </div>
                <div className="id-line">ID: {currentVideo.aweme_id}</div>
              </div>
            </div>
            <div className="quality-row">
              <span className="label">清晰度：</span>
              <div className="quality-options">
                {qualities.map((q) => (
                  <button
                    key={q.ratio}
                    className={
                      "quality-opt" +
                      (selectedQuality?.ratio === q.ratio
                        ? " active"
                        : "")
                    }
                    onClick={() => setSelectedQuality(q)}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="result-actions">
              <button
                className="btn btn-primary"
                onClick={() => download(currentVideo, selectedQuality)}
                disabled={downloading}
              >
                {downloading ? (
                  <>
                    <span className="spinner" /> 准备中...
                  </>
                ) : (
                  "⬇ 下载视频"
                )}
              </button>
              <button className="btn btn-ghost" onClick={copyUrl}>
                🔗 复制无水印链接
              </button>
              <span className="badge">✓ 已解析为无水印地址</span>
            </div>
          </div>
        )}

        {/* 历史 */}
        {history.length > 0 && (
          <div className="history">
            <div className="section-title">
              <h2>🕓 本地历史记录</h2>
              <button className="clear" onClick={clearHistory}>
                清空记录
              </button>
            </div>
            <div className="history-list">
              {history.map((h) => (
                <div className="history-item" key={h.aweme_id + h.ts}>
                  {h.cover_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className="h-cover"
                      src={h.cover_url}
                      alt=""
                      onError={(e) => {
                        const t = e.target as HTMLImageElement;
                        t.classList.add("placeholder");
                        t.removeAttribute("src");
                        t.alt = "无";
                      }}
                    />
                  ) : (
                    <div className="h-cover placeholder">无</div>
                  )}
                  <div className="h-info">
                    <div className="h-title">{h.title}</div>
                    <div className="h-author">
                      {h.author ? "👤 " + h.author : ""} · {timeAgo(h.ts)}
                    </div>
                  </div>
                  <div className="h-actions">
                    <button
                      className="icon-btn"
                      title="重新加载"
                      onClick={() => onHistoryLoad(h)}
                    >
                      ↻
                    </button>
                    <button
                      className="icon-btn"
                      title="下载"
                      onClick={() => onHistoryDl(h)}
                    >
                      ⬇
                    </button>
                    <button
                      className="icon-btn"
                      title="删除"
                      onClick={() => deleteHistory(h.aweme_id)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <footer>本工具仅供个人学习研究使用 · 请尊重原作者版权</footer>
      </div>
    </>
  );
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}
