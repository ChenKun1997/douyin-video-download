"use client";

/**
 * 抖音无水印下载 - 主页面
 *
 * 两种模式 (顶部 tab 切换):
 *   1. 单视频: 粘贴分享文案/链接 -> 解析 -> 预览 -> 下载 (原功能)
 *   2. 用户主页: 输入用户主页链接/sec_uid/抖音号 -> 拉取作品列表 -> 批量/单个下载
 *
 * 单视频模式逻辑与原版完全一致, 此处保留。用户主页模式依赖
 * /api/user/resolve + /api/user/videos (a_bogus 签名接口)。
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ----------------------------------------------------------------------
// 类型
// ----------------------------------------------------------------------

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
  type?: "video" | "album";
  /** 图集模式: 无水印原图列表 */
  images?: AlbumImageItem[];
}

interface AlbumImageItem {
  url: string;
  preview: string | null;
  width: number;
  height: number;
}

interface HistoryItem {
  aweme_id: string;
  title: string;
  author: string;
  cover_url: string | null;
  video_url: string;
  ts: number;
}

interface UserProfile {
  sec_uid: string;
  short_id: string;
  nickname: string;
  avatar_url: string | null;
  aweme_count: number;
  signature: string;
}

interface UserVideo {
  aweme_id: string;
  desc: string;
  create_time: number;
  cover_url: string | null;
  play_url: string | null;
  video_id: string | null;
  duration: number;
}

const HISTORY_KEY = "douyin_history_v1";

type StatusType = "info" | "error" | "success";
interface StatusState {
  type: StatusType;
  msg: string;
}

type Mode = "single" | "user";

// ----------------------------------------------------------------------
// 主组件
// ----------------------------------------------------------------------

export default function Home() {
  const [mode, setMode] = useState<Mode>("single");

  // ----------------- 共用状态提示 -----------------
  const [status, setStatus] = useState<StatusState | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showStatus = useCallback(
    (type: StatusType, msg: string, autoClose = 0) => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
      setStatus({ type, msg });
      if (autoClose) {
        statusTimer.current = setTimeout(() => setStatus(null), autoClose);
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

  // ----------------- 单视频状态 -----------------
  const [input, setInput] = useState("");
  const [parsing, setParsing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [currentVideo, setCurrentVideo] = useState<VideoInfo | null>(null);
  const [selectedQuality, setSelectedQuality] = useState<Quality | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  // ----------------- 用户模式状态 -----------------
  const [userInput, setUserInput] = useState("");
  const [resolving, setResolving] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [userVideos, setUserVideos] = useState<UserVideo[]>([]);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [hasMoreVideos, setHasMoreVideos] = useState(false);
  const [videoCursor, setVideoCursor] = useState(0);
  const [selectedVideos, setSelectedVideos] = useState<Set<string>>(new Set());
  const [batchDl, setBatchDl] = useState<{ done: number; total: number } | null>(
    null,
  );
  // 登录态 cookie (解锁翻页拿全部作品); localStorage 持久化
  const COOKIE_KEY = "douyin_cookie_v1";
  const [cookie, setCookie] = useState("");
  const [showCookieInput, setShowCookieInput] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(COOKIE_KEY) || "";
    setCookie(saved);
  }, []);
  const saveCookie = useCallback((v: string) => {
    setCookie(v);
    if (v.trim()) localStorage.setItem(COOKIE_KEY, v);
    else localStorage.removeItem(COOKIE_KEY);
  }, []);

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

  // ----------------- 单视频: 解析 -----------------
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

  /**
   * 把抖音图床 URL 转为经过本站 /api/proxy?mode=image 转发的地址。
   * 解决浏览器直连 douyinpic.com 在部分网络/地区裂图 (403/超时)。
   * null/空值原样返回, 交给 onError 占位逻辑处理。
   */
  const imgSrc = (url: string | null | undefined): string => {
    if (!url) return "";
    return (
      "/api/proxy?url=" + encodeURIComponent(url) + "&mode=image"
    );
  };

  // ----------------- 下载 (单视频 / 用户列表项共用) -----------------
  const buildFilename = (
    author: string,
    title: string,
    qualityTag: string,
  ): string =>
    (author ? author + "_" : "") +
    title +
    (qualityTag ? "_" + qualityTag : "") +
    ".mp4";

  const downloadVideo = useCallback(
    async (
      url: string,
      filename: string,
      qualityTag = "",
    ): Promise<"ok" | "fail"> => {
      const buildProxyUrl = (m: "redirect" | "stream") =>
        "/api/proxy?url=" +
        encodeURIComponent(url) +
        "&filename=" +
        encodeURIComponent(filename) +
        "&mode=" +
        m;
      const trigger = (proxyUrl: string) => {
        const a = document.createElement("a");
        a.href = proxyUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      };

      try {
        // 优先 stream 模式: 服务端流式返回 + Content-Disposition: attachment,
        // 同源, download 属性有效, 浏览器一定会下载 (不会像 redirect 那样
        // 跟随 302 到跨域 CDN 导致 download 属性失效、页面跳转播放视频)。
        // stream 受 Vercel 10s 超时限制, 大视频可能下载不全 —— 但对绝大多数
        // 抖音视频足够; 超时风险留作 edge case 不再降级到 redirect。
        trigger(buildProxyUrl("stream"));
        return "ok";
      } catch {
        return "fail";
      }
    },
    [],
  );

  const download = useCallback(
    async (video: VideoInfo | null, quality: Quality | null) => {
      if (!video) return;
      const videoUrl = (quality && quality.url) || video.video_url;
      const qualityTag = quality ? quality.label : "";
      const fname = buildFilename(video.author, video.title, qualityTag);
      showStatus("info", `准备下载 ${qualityTag || "视频"}...`);
      setDownloading(true);
      try {
        const r = await downloadVideo(videoUrl, fname, qualityTag);
        showStatus(
          r === "ok" ? "success" : "error",
          r === "ok"
            ? "已开始下载，请查看浏览器下载"
            : "下载失败",
          3000,
        );
      } finally {
        setDownloading(false);
      }
    },
    [downloadVideo, showStatus],
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

  /**
   * 逐张下载图集: 每张图经 /api/proxy?mode=image&filename=... 触发浏览器下载。
   * 不打包成 zip —— 手机端解压麻烦, 逐张保存到相册/下载目录更通用。
   * 顺序触发并加间隔, 规避浏览器「阻止多次下载」拦截。
   */
  const downloadAlbumImages = useCallback(async () => {
    const images = currentVideo?.images;
    if (!images || !images.length) {
      showStatus("error", "没有可下载的图片");
      return;
    }
    setDownloading(true);
    const author = currentVideo?.author || "";
    const base = buildFilename(author, currentVideo?.title || "图集", "").replace(
      /\.mp4$/,
      "",
    );
    showStatus("info", `开始下载 ${images.length} 张图片...`);
    let ok = 0;
    let fail = 0;
    const trigger = (url: string, fname: string) => {
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    try {
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const ext = guessImgExtFromUrl(img.url);
        const fname = `${base}_${String(i + 1).padStart(2, "0")}.${ext}`;
        // 用 attachment 模式: 服务端拉图并强制下载, 避免直连抖音图床裂图
        const proxyUrl =
          "/api/proxy?url=" +
          encodeURIComponent(img.url) +
          "&mode=image&filename=" +
          encodeURIComponent(fname);
        // 探测一次确保能拿到 (失败计数), 再触发下载
        try {
          const probe = await fetch(proxyUrl, { method: "HEAD" });
          if (probe.ok) {
            trigger(proxyUrl, fname);
            ok++;
          } else {
            fail++;
          }
        } catch {
          fail++;
        }
        // 间隔规避浏览器多次下载拦截 (尤其 PC 端 Chrome)
        if (i < images.length - 1) {
          await new Promise((r) => setTimeout(r, 900));
        }
      }
      showStatus(
        fail ? "error" : "success",
        fail
          ? `下载 ${ok} 张成功 / ${fail} 张失败`
          : `已触发下载 ${ok} 张图片, 请查看浏览器/相册`,
        4000,
      );
    } finally {
      setDownloading(false);
    }
  }, [currentVideo, showStatus]);

  const onHistoryLoad = (item: HistoryItem) => {
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

  // ----------------- 用户模式: 解析 + 拉取 -----------------
  const resolveUser = useCallback(async () => {
    const text = userInput.trim();
    if (!text) {
      showStatus("error", "请输入用户主页链接或 sec_uid");
      return;
    }
    setResolving(true);
    setProfile(null);
    setUserVideos([]);
    setSelectedVideos(new Set());
    setHasMoreVideos(false);
    showStatus("info", "正在解析用户...");
    try {
      const resp = await fetch("/api/user/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: text }),
      });
      const json = await resp.json();
      if (!resp.ok || !json.ok) {
        throw new Error(json.error || `请求失败 (${resp.status})`);
      }
      setProfile(json.profile as UserProfile);
      showStatus(
        "success",
        `已解析: ${json.profile.nickname} (${json.profile.aweme_count} 个作品)`,
        2500,
      );
      // 自动拉取作品列表 (受抖音匿名接口限制, 仅最近 ~41 个)
      void loadVideos(json.profile.sec_uid);
    } catch (e) {
      showStatus(
        "error",
        "解析失败：" + (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setResolving(false);
    }
  }, [userInput, showStatus]);

  const loadVideos = useCallback(
    async (
      secUid: string,
      cursor = 0,
      append = false,
      // 显式覆盖 cookie: 保存/清除 cookie 后, setCookie 是异步的, 闭包里
      // 的 cookie 还是旧值, 故允许调用方直接传入刚保存的值。
      cookieOverride?: string,
    ) => {
      setLoadingVideos(true);
      showStatus("info", append ? "正在加载更多..." : "正在加载作品列表...");
      try {
        const effectiveCookie =
          cookieOverride !== undefined ? cookieOverride : cookie;
        const headers: Record<string, string> = {};
        if (effectiveCookie.trim()) headers["X-Douyin-Cookie"] = effectiveCookie.trim();
        // 翻页时只拉 10 条 (更快); 首次拿满 (匿名上限 ~41)
        const countParam = append ? "&count=10" : "";
        const resp = await fetch(
          `/api/user/videos?sec_uid=${encodeURIComponent(secUid)}&cursor=${cursor}${countParam}`,
          { headers },
        );
        const json = await resp.json();
        if (!resp.ok || !json.ok) {
          throw new Error(json.error || `请求失败 (${resp.status})`);
        }
        const page = json.page;
        setUserVideos((prev) => (append ? [...prev, ...page.items] : page.items));
        // 登录态下 page.can_fetch_more 为 true 才能翻页; 匿名恒为 false
        setHasMoreVideos(!!page.can_fetch_more);
        setVideoCursor(Number(page.max_cursor || 0));
        showStatus(
          "success",
          append
            ? `又加载 ${page.items.length} 个 (共 ${userVideos.length + page.items.length})`
            : `已加载 ${page.items.length} 个作品${cookie.trim() ? "（登录态）" : ""}`,
          2000,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showStatus(
          "error",
          /风控|签名|429|verify/i.test(msg)
            ? "触发抖音风控，请稍后再试"
            : "加载失败：" + msg,
        );
      } finally {
        setLoadingVideos(false);
      }
    },
    [showStatus, cookie, userVideos.length],
  );

  // ----------------- 用户模式: 选择 + 批量下载 -----------------
  const toggleSelect = (id: string) => {
    setSelectedVideos((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedVideos(new Set(userVideos.map((v) => v.aweme_id)));
  };
  const selectNone = () => setSelectedVideos(new Set());

  const buildUserVideoUrl = (v: UserVideo): string | null => {
    if (v.video_id) {
      return `https://aweme.snssdk.com/aweme/v1/play/?video_id=${v.video_id}&ratio=720p&line=0`;
    }
    return v.play_url;
  };

  const downloadOne = useCallback(
    async (v: UserVideo) => {
      const url = buildUserVideoUrl(v);
      if (!url) {
        showStatus("error", "该视频缺少可下载地址");
        return;
      }
      const author = profile?.nickname || "";
      const fname = buildFilename(author, v.desc || v.aweme_id, "720P");
      showStatus("info", "准备下载...");
      await downloadVideo(url, fname, "720P");
    },
    [profile, downloadVideo, showStatus],
  );

  const downloadBatch = useCallback(async () => {
    const targets = userVideos.filter((v) => selectedVideos.has(v.aweme_id));
    if (!targets.length) {
      showStatus("error", "请先勾选要下载的作品");
      return;
    }
    setBatchDl({ done: 0, total: targets.length });
    const author = profile?.nickname || "";
    let done = 0;
    let fail = 0;
    for (const v of targets) {
      const url = buildUserVideoUrl(v);
      if (!url) {
        fail++;
      } else {
        const fname = buildFilename(author, v.desc || v.aweme_id, "720P");
        const r = await downloadVideo(url, fname, "720P");
        if (r === "fail") fail++;
        // 浏览器并发下载限制: 顺序触发, 间隔避免被浏览器拦截
        await new Promise((res) => setTimeout(res, 800));
      }
      done++;
      setBatchDl({ done, total: targets.length });
    }
    setBatchDl(null);
    showStatus(
      fail ? "error" : "success",
      fail
        ? `批量下载完成, ${done - fail} 成功 / ${fail} 失败`
        : `批量下载已全部触发 (${done} 个)`,
      4000,
    );
  }, [userVideos, selectedVideos, profile, downloadVideo, showStatus]);

  const pasteUserFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setUserInput(text.trim());
      showStatus("info", "已粘贴剪贴板内容", 1500);
    } catch {
      showStatus("error", "无法读取剪贴板，请手动粘贴");
    }
  }, [showStatus]);

  // ----------------------------------------------------------------------
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
          粘贴分享文案解析单个视频，或输入用户主页批量下载
        </div>
      </header>

      <div className="wrap">
        {/* 模式切换 */}
        <div className="mode-tabs">
          <button
            className={"mode-tab" + (mode === "single" ? " active" : "")}
            onClick={() => setMode("single")}
          >
            🎬 单个视频
          </button>
          <button
            className={"mode-tab" + (mode === "user" ? " active" : "")}
            onClick={() => setMode("user")}
          >
            👤 用户主页
          </button>
        </div>

        {/* ============ 单视频模式 ============ */}
        {mode === "single" && (
          <>
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
                  <div className="row-secondary">
                    <button
                      className="btn btn-ghost"
                      onClick={pasteFromClipboard}
                    >
                      📋 粘贴剪贴板
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={() => setInput("")}
                    >
                      ✖ 清空
                    </button>
                  </div>
                </div>
              </div>
              <div className="hint">
                <span className="tag">提示</span>
                支持短链 v.douyin.com / 长链 www.douyin.com，可直接粘贴 App
                分享的整段文案（视频或图集均可）·
                输入框内按 Ctrl/Cmd + Enter 快速解析
              </div>
            </div>

            {status && <StatusBar status={status} />}

            {currentVideo && (
              <div className="result">
                <div className="result-head">
                  {currentVideo.cover_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className="cover"
                      src={imgSrc(currentVideo.cover_url)}
                      alt="封面"
                      referrerPolicy="no-referrer"
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
                {/* 图集模式: 预览 + 逐张下载 */}
                {currentVideo.type === "album" &&
                  currentVideo.images &&
                  currentVideo.images.length > 0 && (
                    <>
                      <div className="album-meta">
                        <span className="badge">📷 图集 · {currentVideo.images.length} 张</span>
                        <span className="badge">✓ 无水印原图</span>
                      </div>
                      <div className="album-grid">
                        {currentVideo.images.map((img, idx) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <a
                            key={idx}
                            className="album-cell"
                            href={imgSrc(img.preview || img.url)}
                            target="_blank"
                            rel="noreferrer"
                            title="点击查看大图"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={imgSrc(img.preview || img.url)}
                              alt={`图 ${idx + 1}`}
                              referrerPolicy="no-referrer"
                              loading="lazy"
                              onError={(e) => {
                                const t = e.target as HTMLImageElement;
                                t.classList.add("placeholder");
                                t.removeAttribute("src");
                                t.alt = "无";
                              }}
                            />
                            <span className="album-idx">{idx + 1}</span>
                          </a>
                        ))}
                      </div>
                      <div className="result-actions">
                        <button
                          className="btn btn-primary"
                          onClick={downloadAlbumImages}
                          disabled={downloading}
                        >
                          {downloading ? (
                            <>
                              <span className="spinner" /> 下载中...
                            </>
                          ) : (
                            `⬇ 下载全部图片 (${currentVideo.images.length} 张)`
                          )}
                        </button>
                        <span className="badge">逐张保存，不打包（方便手机端）</span>
                      </div>
                    </>
                  )}

                {/* 视频模式: 清晰度 + 下载 */}
                {currentVideo.type !== "album" && (
                  <>
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
                  </>
                )}
              </div>
            )}

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
                          src={imgSrc(h.cover_url)}
                          alt=""
                          referrerPolicy="no-referrer"
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
                      <button
                        type="button"
                        className="h-info"
                        title="点击重新加载"
                        onClick={() => onHistoryLoad(h)}
                      >
                        <div className="h-title">{h.title}</div>
                        <div className="h-author">
                          {h.author ? "👤 " + h.author : ""} · {timeAgo(h.ts)}
                        </div>
                      </button>
                      <div className="h-actions">
                        <button
                          className="icon-btn"
                          title="下载"
                          onClick={() => onHistoryDl(h)}
                        >
                          ⬇
                        </button>
                        <button
                          className="icon-btn danger"
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
          </>
        )}

        {/* ============ 用户主页模式 ============ */}
        {mode === "user" && (
          <>
            <div className="input-card">
              <div className="input-row">
                <textarea
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder={
                    "粘贴用户主页链接或 sec_uid，例如：\nhttps://www.douyin.com/user/MS4wLjABAAAA...\n或直接粘贴抖音 App「分享主页」复制的整段文案"
                  }
                />
                <div className="btn-group">
                  <button
                    className="btn btn-primary"
                    onClick={resolveUser}
                    disabled={resolving}
                  >
                    {resolving ? (
                      <>
                        <span className="spinner" /> 解析中...
                      </>
                    ) : (
                      "🔍 解析用户"
                    )}
                  </button>
                  <div className="row-secondary">
                    <button
                      className="btn btn-ghost"
                      onClick={pasteUserFromClipboard}
                    >
                      📋 粘贴剪贴板
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        setUserInput("");
                        setProfile(null);
                        setUserVideos([]);
                        setSelectedVideos(new Set());
                      }}
                    >
                      ✖ 清空
                    </button>
                  </div>
                </div>
              </div>
              <div className="hint">
                <span className="tag">提示</span>
                推荐：主页长链 www.douyin.com/user/MS4...、v.douyin
                分享短链、或 App「分享主页」的整段文案、裸 sec_uid。
                ⚠️ 抖音号/数字ID 匿名搜索需登录态，大概率解析不了；
                受抖音匿名接口限制，单用户最多加载最近约 41 个作品
              </div>

              {/* 登录 Cookie (解锁翻页拿全部作品) */}
              <div className="cookie-row">
                <button
                  type="button"
                  className="cookie-toggle"
                  onClick={() => setShowCookieInput((v) => !v)}
                >
                  {cookie.trim() ? "🔓 登录态（已填 Cookie）" : "🔒 匿名模式"}{" "}
                  · 点击{showCookieInput ? "收起" : "填写登录 Cookie 解锁全部"}
                </button>
                {showCookieInput && (
                  <div className="cookie-input">
                    <textarea
                      value={cookie}
                      onChange={(e) => setCookie(e.target.value)}
                      placeholder={
                        "（可选）粘贴抖音登录 Cookie，解锁翻页拿全部作品。\n获取方式：电脑浏览器登录 www.douyin.com → F12 → Application/Network → 复制整段 Cookie，需含 sessionid、ttwid 等。\n⚠️ 仅存在本机 localStorage，不上传服务器存储。"
                      }
                    />
                    <div className="cookie-actions">
                      <button
                        className="btn btn-ghost"
                        onClick={() => {
                          saveCookie(cookie);
                          // 保存登录 Cookie 后, 若已解析出用户, 用登录态重拉首页,
                          // 这样 canFetchMore 变 true, 「加载更多」按钮随之出现。
                          // (传 cookie 覆盖: setCookie 异步, 闭包里还是旧值)
                          if (profile) {
                            setUserVideos([]);
                            setVideoCursor(0);
                            setHasMoreVideos(false);
                            void loadVideos(profile.sec_uid, 0, false, cookie);
                          }
                        }}
                      >
                        保存
                      </button>
                      <button
                        className="btn btn-ghost"
                        onClick={() => {
                          saveCookie("");
                          // 清除 Cookie 后回到匿名模式, 重新拉首页 (最多 ~41 条)
                          if (profile) {
                            setUserVideos([]);
                            setVideoCursor(0);
                            setHasMoreVideos(false);
                            void loadVideos(profile.sec_uid, 0, false, "");
                          }
                        }}
                      >
                        清除
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {status && <StatusBar status={status} />}

            {/* 用户资料卡 */}
            {profile && (
              <div className="result user-profile">
                <div className="result-head">
                  {profile.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className="cover avatar"
                      src={imgSrc(profile.avatar_url)}
                      alt="头像"
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        const t = e.target as HTMLImageElement;
                        t.classList.add("placeholder");
                        t.removeAttribute("src");
                        t.alt = "无头像";
                      }}
                    />
                  ) : (
                    <div className="cover placeholder">无头像</div>
                  )}
                  <div className="meta">
                    <div className="title">{profile.nickname}</div>
                    <div className="author">
                      📼 作品 {profile.aweme_count} 个
                      {profile.short_id && profile.short_id !== "0"
                        ? " · ID " + profile.short_id
                        : ""}
                    </div>
                    {profile.signature && (
                      <div className="id-line">{profile.signature}</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 作品列表 */}
            {profile && userVideos.length > 0 && (
              <div className="user-videos">
                <div className="section-title">
                  <h2>
                    📋 作品列表（已加载 {userVideos.length}
                    {profile.aweme_count ? ` / ${profile.aweme_count}` : ""}）
                  </h2>
                  <div className="uv-toolbar">
                    <button className="clear" onClick={selectAll}>
                      全选
                    </button>
                    <button className="clear" onClick={selectNone}>
                      取消全选
                    </button>
                    <button
                      className="clear"
                      onClick={downloadBatch}
                      disabled={!!batchDl || selectedVideos.size === 0}
                    >
                      {batchDl
                        ? `批量下载 ${batchDl.done}/${batchDl.total}`
                        : `⬇ 下载选中 (${selectedVideos.size})`}
                    </button>
                  </div>
                </div>
                <div className="uv-grid">
                  {userVideos.map((v) => (
                    <div
                      className={
                        "uv-item" +
                        (selectedVideos.has(v.aweme_id) ? " selected" : "")
                      }
                      key={v.aweme_id}
                    >
                      <label className="uv-card">
                        <input
                          type="checkbox"
                          checked={selectedVideos.has(v.aweme_id)}
                          onChange={() => toggleSelect(v.aweme_id)}
                        />
                        <div className="uv-thumb">
                          {v.cover_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={imgSrc(v.cover_url)}
                              alt=""
                              referrerPolicy="no-referrer"
                              onError={(e) => {
                                const t = e.target as HTMLImageElement;
                                t.classList.add("placeholder");
                                t.removeAttribute("src");
                                t.alt = "无";
                              }}
                            />
                          ) : (
                            <div className="placeholder">无封面</div>
                          )}
                          {v.duration > 0 && (
                            <span className="uv-dur">{fmtDur(v.duration)}</span>
                          )}
                        </div>
                        <div className="uv-info">
                          <div className="uv-title">{v.desc || v.aweme_id}</div>
                          <div className="uv-date">
                            {v.create_time
                              ? new Date(v.create_time * 1000)
                                  .toISOString()
                                  .slice(0, 10)
                              : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="uv-dl"
                          title="下载此视频"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void downloadOne(v);
                          }}
                        >
                          ⬇
                        </button>
                      </label>
                    </div>
                  ))}
                </div>

                {/* 加载更多 (仅登录态可翻页) / 限制说明 */}
                <div className="uv-more">
                  {hasMoreVideos ? (
                    <button
                      className="btn btn-primary"
                      onClick={() => loadVideos(profile.sec_uid, videoCursor, true)}
                      disabled={loadingVideos}
                    >
                      {loadingVideos ? (
                        <>
                          <span className="spinner" /> 加载中...
                        </>
                      ) : (
                        "⬇ 加载更多"
                      )}
                    </button>
                  ) : (
                    <span className="badge uv-limit">
                      {cookie.trim()
                        ? `已加载 ${userVideos.length} 个作品`
                        : profile.aweme_count > userVideos.length
                          ? `已加载最近 ${userVideos.length} 个作品 · 匿名接口限制（共 ${profile.aweme_count} 个，填登录 Cookie 可拿全部）`
                          : `已加载全部 ${userVideos.length} 个作品`}
                    </span>
                  )}
                </div>
              </div>
            )}

            {profile && userVideos.length === 0 && !loadingVideos && (
              <div className="result">
                <div className="meta">
                  <div className="title">未加载到作品</div>
                  <div className="author">
                    该用户可能无公开作品，或已触发抖音风控
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        <footer>本工具仅供个人学习研究使用 · 请尊重原作者版权</footer>
      </div>
    </>
  );
}

// ----------------------------------------------------------------------
// 子组件 / 工具
// ----------------------------------------------------------------------

function StatusBar({ status }: { status: StatusState }) {
  return (
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
  );
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** 从图片 URL 猜扩展名 (抖音图集原图多为 webp/jpeg)。 */
function guessImgExtFromUrl(url: string): string {
  const u = url.toLowerCase();
  if (u.includes(".png")) return "png";
  if (u.includes(".jpg") || u.includes(".jpeg")) return "jpg";
  // 抖音图集默认 webp (含 ~tplv-... 标识的图床多为 webp)
  return "webp";
}
