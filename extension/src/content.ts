/**
 * 抖音无水印下载 · content script。
 *
 * 注入范围: 整个 www.douyin.com 域 (推荐流 / 首页 / 详情页 均生效)。
 * 当前视频的 aweme_id 检测:
 *   - 推荐/首页: URL 里没有 id, 从 DOM 的 [data-e2e="feed-active-video"] 容器
 *     的 data-e2e-vid 属性取 (抖音 E2E 测试钩子, 比混淆 class 稳定)。
 *   - /video/{id}、/note/{id} 直链: 从 URL 取 (兜底)。
 *
 * 注入内容:
 *   - 右下角浮动「下载」按钮 (取到当前 id 时显示, 否则隐藏)
 *   - 点击 → 弹出预览面板 (视频: 封面+清晰度; 图集: 缩略图网格)
 *   - 选清晰度 / 「下载全部」→ 通过 background 下载
 *
 * 跟踪: MutationObserver + scroll + history patch, 去抖 200ms, 随滚动切换视频
 * 自动更新当前 id。面板打开期间冻结按钮, 防止滚动导致内容错乱。
 *
 * UI 用原生 DOM + 内联样式 (不打包 CSS), 放进 ShadowRoot 与页面隔离。
 */

import {
  buildVideoFilename,
  guessImgExtFromUrl,
  sanitizeFilename,
} from "./douyin-ext";
import type {
  AlbumData,
  ParseResponse,
  ParsedData,
  VideoData,
} from "./types";

declare const chrome: any;

// ----------------------------------------------------------------------
// 当前视频 aweme_id 检测
// ----------------------------------------------------------------------

/**
 * ★ 抖音推荐流当前视频的 aweme_id 不在 URL 里, 而在 DOM。
 * 定位思路:以「正在播放的 <video> 元素」为锚点 (这是用户实际看到的那条),
 * 向上找到它所属的视频容器, 再取 id。
 *
 * 为什么不直接 querySelector('[data-e2e="feed-active-video"]'):
 *   切换 tab (推荐→关注/朋友) 时, 旧 feed 的节点可能仍残留在 DOM 里
 *   且排在前面, querySelector 命中的是过时节点, id 就是错的。
 *   而「未暂停、正在播放」的 video 只有一个, 才是当前真实展示的视频。
 *
 * data-e2e="feed-active-video" + data-e2e-vid 是抖音 E2E 测试钩子
 * (比混淆 class 稳定, 社区现役脚本在用)。若改版换了值, 改下方两个常量即可。
 */
const ACTIVE_VIDEO_SEL = '[data-e2e="feed-active-video"]';

/** 元素中心点是否落在视口内 (用于剔除滚出视野/隐藏 tab 的残留 video)。 */
function isCenterInView(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  return cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= window.innerHeight;
}

/**
 * 从「正在播放的 <video>」取其所属视频的 aweme_id。
 *
 * 选取优先级 (兼顾切 tab 时序抖动):
 *   1) 可见 + 正在播放  ← 最佳, 即用户此刻看到/听到的
 *   2) 可见 (未播放)     ← 刚切 tab 自动播放还没起来
 *   3) 正在播放 (不可见) ← 视口边缘小概率
 *   4) 第一个            ← 兜底
 */
function getAwemeIdFromDom(): string | null {
  const videos = Array.from(document.querySelectorAll<HTMLVideoElement>("video"));
  const visible = videos.filter(isCenterInView);
  const isPlaying = (v: HTMLVideoElement) =>
    !v.paused && !v.ended && v.readyState >= 2;

  const pick =
    visible.find(isPlaying) ||
    visible[0] ||
    videos.find(isPlaying) ||
    videos[0] ||
    null;

  if (pick) {
    // 向上找视频容器, 取 data-e2e-vid
    const wrap = pick.closest<HTMLElement>(ACTIVE_VIDEO_SEL);
    const vid = wrap?.getAttribute("data-e2e-vid");
    if (vid) return vid;
    // 某些场景容器上没 vid, 试最近的带 data-e2e-vid 的祖先
    const anyVid = pick
      .closest<HTMLElement>("[data-e2e-vid]")
      ?.getAttribute("data-e2e-vid");
    if (anyVid) return anyVid;
  }

  // 兜底: 若播放中的 video 找不到容器 id, 退而用 active-video 标记
  // (仅当文档里只有一个时才采信, 避免取到过时的残留节点)
  const actives = document.querySelectorAll<HTMLElement>(ACTIVE_VIDEO_SEL);
  if (actives.length === 1) {
    const vid = actives[0].getAttribute("data-e2e-vid");
    if (vid) return vid;
  }
  return null;
}

/** 从 URL 兜底取 aweme_id (/video/{id}、/note/{id} 直链场景)。 */
function getAwemeIdFromUrl(): string | null {
  const m = window.location.pathname.match(/\/(?:video|note)\/(\d+)/);
  return m ? m[1] : null;
}

/** 当前视频 aweme_id: DOM 优先, URL 兜底。 */
function getCurrentAwemeId(): string | null {
  return getAwemeIdFromDom() || getAwemeIdFromUrl();
}

// ----------------------------------------------------------------------
// 入口: 按钮注入 + 当前视频跟踪
// ----------------------------------------------------------------------

let buttonMounted = false;

function main() {
  // 首次尝试注入按钮
  syncButton();

  // 抖音是 SPA, 当前视频随滚动/翻页切换 (但 URL 往往不变), 用 MutationObserver
  // 监听 DOM 变化; scroll 是用户翻下一条的强信号。去抖避免高频触发。
  patchHistory();
  window.addEventListener("popstate", scheduleSync);
  window.addEventListener("scroll", scheduleSync, { passive: true });
  window.addEventListener("dy-dl-locationchange", scheduleSync);

  const observer = new MutationObserver(scheduleSync);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-e2e", "data-e2e-vid"],
  });
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSync() {
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncButton();
  }, 200);
}

/** 根据当前是否能取到 aweme_id, 决定按钮显示/隐藏。 */
function syncButton() {
  // 面板打开时不要动按钮 (用户正在操作当前视频)
  if (panelOpen) return;
  const id = getCurrentAwemeId();
  if (id) {
    if (!buttonMounted) {
      injectButton();
      buttonMounted = true;
    }
  } else {
    if (buttonMounted) {
      removeButton();
      buttonMounted = false;
    }
  }
}

// ----------------------------------------------------------------------
// 历史 API patch (检测 SPA 路由变化)
// ----------------------------------------------------------------------

let historyPatched = false;
function patchHistory() {
  if (historyPatched) return;
  historyPatched = true;
  for (const type of ["pushState", "replaceState"] as const) {
    const orig = history[type] as Function;
    history[type] = function (...args: unknown[]) {
      const r = orig.apply(this, args);
      window.dispatchEvent(new Event("dy-dl-locationchange"));
      return r;
    };
  }
}

// ----------------------------------------------------------------------
// 浮动按钮
// ----------------------------------------------------------------------

let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;

function injectButton() {
  if (host && document.body.contains(host)) return;
  host = document.createElement("div");
  host.id = "douyin-dl-host";
  shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = BUTTON_HTML;
  document.documentElement.appendChild(host);

  const btn = shadow.querySelector<HTMLButtonElement>("#dy-dl-btn")!;
  btn.addEventListener("click", onButtonClick);
}

function removeButton() {
  if (host) {
    host.remove();
    host = null;
    shadow = null;
  }
}

async function onButtonClick() {
  const awemeId = getCurrentAwemeId();
  if (!awemeId) return;
  showPanel({ state: "loading" });
  try {
    const resp: ParseResponse = await sendMsg({
      type: "parse",
      awemeId,
      sourceUrl: location.href,
    });
    if (!resp.ok) {
      showPanel({ state: "error", msg: resp.error });
      return;
    }
    showPanel({ state: "result", data: resp.data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showPanel({ state: "error", msg });
  }
}

function sendMsg(msg: unknown): Promise<any> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp: any) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp);
    });
  });
}

// ----------------------------------------------------------------------
// 面板 UI
// ----------------------------------------------------------------------

type PanelState =
  | { state: "loading" }
  | { state: "error"; msg: string }
  | { state: "result"; data: ParsedData };

let currentData: ParsedData | null = null;
let selectedRatio = "720p";
/** 面板是否打开: 打开期间冻结按钮注入 (syncButton 直接返回), 防滚动切换视频错乱。 */
let panelOpen = false;

function showPanel(s: PanelState) {
  if (!shadow) return;
  // 移除旧面板
  shadow.querySelector("#dy-dl-panel")?.remove();

  const panel = document.createElement("div");
  panel.id = "dy-dl-panel";
  panel.innerHTML = PANEL_HTML;
  shadow.appendChild(panel);
  panelOpen = true;

  const closeBtn = panel.querySelector<HTMLButtonElement>("#dy-dl-close")!;
  const closePanel = () => {
    panel.remove();
    panelOpen = false;
    syncButton();
  };
  closeBtn.addEventListener("click", closePanel);

  const body = panel.querySelector<HTMLDivElement>("#dy-dl-body")!;
  const title = panel.querySelector<HTMLDivElement>("#dy-dl-title")!;

  if (s.state === "loading") {
    title.textContent = "解析中…";
    body.innerHTML = `<div class="dy-spinner"></div>`;
  } else if (s.state === "error") {
    title.textContent = "解析失败";
    body.innerHTML = `<div class="dy-error">${escapeHtml(s.msg)}</div>`;
  } else {
    currentData = s.data;
    renderResult(title, body, s.data);
  }

  // 按 Esc 关闭
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      closePanel();
      document.removeEventListener("keydown", onKey);
    }
  };
  document.addEventListener("keydown", onKey);
}

function renderResult(
  titleEl: HTMLDivElement,
  body: HTMLDivElement,
  data: ParsedData,
) {
  const authorTag = data.author ? `@${data.author}` : "";
  titleEl.textContent = data.title || "未命名";

  if (data.type === "video") {
    renderVideo(body, data);
  } else {
    renderAlbum(body, data);
  }
  // 顶部作者信息
  const meta = document.createElement("div");
  meta.className = "dy-meta";
  meta.textContent = authorTag;
  body.insertBefore(meta, body.firstChild);
}

function renderVideo(body: HTMLDivElement, data: VideoData) {
  const qualities = data.qualities.length
    ? data.qualities
    : [
        {
          ratio: "default",
          label: "默认",
          url: data.video_url,
        },
      ];
  // 默认选 720p
  selectedRatio =
    qualities.find((q) => q.ratio === "720p")?.ratio || qualities[0].ratio;

  body.innerHTML = "";

  // 封面
  if (data.cover_url) {
    const cover = document.createElement("div");
    cover.className = "dy-cover";
    const img = document.createElement("img");
    img.src = data.cover_url;
    img.alt = "封面";
    cover.appendChild(img);
    body.appendChild(cover);
  }

  // 清晰度选择
  const qWrap = document.createElement("div");
  qWrap.className = "dy-quality";
  qWrap.textContent = "清晰度：";
  for (const q of qualities) {
    const b = document.createElement("button");
    b.className = "dy-q-opt" + (q.ratio === selectedRatio ? " active" : "");
    b.textContent = q.label;
    b.dataset.ratio = q.ratio;
    b.addEventListener("click", () => {
      selectedRatio = q.ratio;
      qWrap.querySelectorAll(".dy-q-opt").forEach((el) =>
        el.classList.remove("active"),
      );
      b.classList.add("active");
    });
    qWrap.appendChild(b);
  }
  body.appendChild(qWrap);

  // 下载按钮
  const dlBtn = document.createElement("button");
  dlBtn.className = "dy-dl-btn";
  dlBtn.textContent = "下载视频";
  dlBtn.addEventListener("click", async () => {
    const q =
      qualities.find((x) => x.ratio === selectedRatio) || qualities[0];
    const filename = buildVideoFilename(data.author, data.title, q.label);
    dlBtn.disabled = true;
    dlBtn.textContent = "下载中…";
    const resp = await sendMsg({ type: "download", url: q.url, filename });
    dlBtn.disabled = false;
    dlBtn.textContent = resp?.ok ? "已开始下载 ✓" : "下载失败,重试";
    if (resp?.ok) {
      setTimeout(() => {
        dlBtn.textContent = "下载视频";
      }, 2000);
    }
  });
  body.appendChild(dlBtn);
}

function renderAlbum(body: HTMLDivElement, data: AlbumData) {
  body.innerHTML = "";
  const count = data.images.length;

  const grid = document.createElement("div");
  grid.className = "dy-album-grid";
  for (const img of data.images) {
    const cell = document.createElement("div");
    cell.className = "dy-album-cell";
    const im = document.createElement("img");
    im.src = img.preview || img.url;
    im.alt = "图片";
    im.loading = "lazy";
    cell.appendChild(im);
    grid.appendChild(cell);
  }
  body.appendChild(grid);

  const dlAll = document.createElement("button");
  dlAll.className = "dy-dl-btn";
  dlAll.textContent = `下载全部图片 (${count} 张)`;
  dlAll.addEventListener("click", async () => {
    dlAll.disabled = true;
    let done = 0;
    const base = sanitizeFilename(
      (data.author ? data.author + "_" : "") + data.title,
    );
    for (let i = 0; i < data.images.length; i++) {
      const img = data.images[i];
      const ext = guessImgExtFromUrl(img.url);
      const num = String(i + 1).padStart(2, "0");
      const filename = `${base}_${num}.${ext}`;
      await sendMsg({ type: "download", url: img.url, filename });
      done++;
      dlAll.textContent = `下载中… ${done}/${count}`;
      // 错开, 避免浏览器拦截多文件下载
      await sleep(800);
    }
    dlAll.disabled = false;
    dlAll.textContent = "全部已开始下载 ✓";
    setTimeout(() => {
      dlAll.textContent = `下载全部图片 (${count} 张)`;
    }, 2500);
  });
  body.appendChild(dlAll);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ----------------------------------------------------------------------
// 样式 (注入到 ShadowRoot, 与页面隔离)
// ----------------------------------------------------------------------

const BUTTON_HTML = `
<style>
  #dy-dl-btn {
    position: fixed;
    right: 24px;
    bottom: 96px;
    z-index: 2147483646;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 16px;
    border: none;
    border-radius: 999px;
    background: linear-gradient(135deg, #fe2c55, #ff5e7e);
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(254, 44, 85, 0.4);
    transition: transform 0.15s, opacity 0.15s;
  }
  #dy-dl-btn:hover { transform: translateY(-2px); }
  #dy-dl-btn:active { transform: translateY(0); }
  #dy-dl-btn svg { width: 16px; height: 16px; }
</style>
<button id="dy-dl-btn" title="无水印下载">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
  无水印下载
</button>`;

const PANEL_HTML = `
<style>
  #dy-dl-panel {
    position: fixed;
    right: 24px;
    bottom: 160px;
    z-index: 2147483647;
    width: 320px;
    max-height: 70vh;
    overflow-y: auto;
    background: #fff;
    border-radius: 16px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.22);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #161823;
    animation: dy-pop 0.18s ease-out;
  }
  @keyframes dy-pop {
    from { opacity: 0; transform: translateY(12px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .dy-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px; border-bottom: 1px solid #f0f0f0;
  }
  #dy-dl-title {
    font-size: 15px; font-weight: 600; max-width: 230px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #dy-dl-close {
    border: none; background: transparent; cursor: pointer;
    font-size: 20px; color: #8a8b91; line-height: 1; padding: 4px;
  }
  #dy-dl-close:hover { color: #161823; }
  #dy-dl-body { padding: 14px 16px; }
  .dy-meta { font-size: 13px; color: #fe2c55; margin-bottom: 10px; font-weight: 500; }
  .dy-cover { margin-bottom: 12px; border-radius: 8px; overflow: hidden; }
  .dy-cover img { width: 100%; display: block; }
  .dy-quality { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; font-size: 13px; color: #6c6c74; }
  .dy-q-opt {
    padding: 5px 12px; border: 1px solid #e3e3e6; border-radius: 999px;
    background: #fff; cursor: pointer; font-size: 12px; color: #161823;
    transition: all 0.12s;
  }
  .dy-q-opt:hover { border-color: #fe2c55; color: #fe2c55; }
  .dy-q-opt.active { background: #fe2c55; border-color: #fe2c55; color: #fff; }
  .dy-dl-btn {
    width: 100%; padding: 11px; border: none; border-radius: 10px;
    background: #fe2c55; color: #fff; font-size: 14px; font-weight: 600;
    cursor: pointer; transition: opacity 0.12s;
  }
  .dy-dl-btn:hover { opacity: 0.9; }
  .dy-dl-btn:disabled { opacity: 0.6; cursor: default; }
  .dy-album-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 14px; }
  .dy-album-cell { aspect-ratio: 1; border-radius: 6px; overflow: hidden; background: #f0f0f0; }
  .dy-album-cell img { width: 100%; height: 100%; object-fit: cover; }
  .dy-spinner {
    width: 28px; height: 28px; margin: 20px auto;
    border: 3px solid #f0f0f0; border-top-color: #fe2c55;
    border-radius: 50%; animation: dy-spin 0.8s linear infinite;
  }
  @keyframes dy-spin { to { transform: rotate(360deg); } }
  .dy-error { font-size: 13px; color: #fe2c55; line-height: 1.6; word-break: break-word; padding: 8px 0; }
</style>
<div id="dy-dl-panel">
  <div class="dy-header">
    <div id="dy-dl-title"></div>
    <button id="dy-dl-close" title="关闭">×</button>
  </div>
  <div id="dy-dl-body"></div>
</div>`;

// ----------------------------------------------------------------------
// 启动
// ----------------------------------------------------------------------

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
