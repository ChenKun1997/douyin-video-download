/**
 * 抖音无水印下载 · popup 脚本。
 *
 * 工具栏弹窗: 粘贴分享文案/链接 → 解析 → 在弹窗内预览 + 下载。
 * 通过 background service worker 解析与下载 (复用 content 的消息协议)。
 */

import {
  buildVideoFilename,
  guessImgExtFromUrl,
  sanitizeFilename,
} from "./douyin-ext";
import type { ParsedData, ParseResponse } from "./types";

declare const chrome: any;

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

let currentData: ParsedData | null = null;
let selectedRatio = "720p";

window.addEventListener("DOMContentLoaded", () => {
  $("input").focus();

  $("paste").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      ($("input") as HTMLTextAreaElement).value = text;
    } catch {
      setStatus("无法读取剪贴板, 请手动粘贴");
    }
  });

  $("parse").addEventListener("click", doParse);
  $("input").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") doParse();
  });
});

async function doParse() {
  const text = ($("input") as HTMLTextAreaElement).value.trim();
  if (!text) {
    setStatus("请粘贴抖音链接或分享文案");
    return;
  }
  setStatus("解析中…");
  $("result").innerHTML = `<div class="spinner"></div>`;
  ($("parse") as HTMLButtonElement).disabled = true;

  try {
    const resp: ParseResponse = await sendMsg({ type: "parse", text });
    if (!resp.ok) {
      setStatus(resp.error);
      $("result").innerHTML = "";
      return;
    }
    setStatus("");
    currentData = resp.data;
    renderResult(resp.data);
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
    $("result").innerHTML = "";
    } finally {
    ($("parse") as HTMLButtonElement).disabled = false;
  }
}

function renderResult(data: ParsedData) {
  const el = $("result");
  el.innerHTML = "";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = data.author ? `@${data.author}` : "";
  el.appendChild(meta);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = data.title || "未命名";
  el.appendChild(title);

  if (data.type === "video") {
    renderVideo(el, data);
  } else {
    renderAlbum(el, data);
  }
}

function renderVideo(el: HTMLElement, data: Extract<ParsedData, { type: "video" }>) {
  if (data.cover_url) {
    const img = document.createElement("img");
    img.className = "cover";
    img.src = data.cover_url;
    el.appendChild(img);
  }

  const qualities = data.qualities.length
    ? data.qualities
    : [{ ratio: "default", label: "默认", url: data.video_url }];
  selectedRatio =
    qualities.find((q) => q.ratio === "720p")?.ratio || qualities[0].ratio;

  const wrap = document.createElement("div");
  wrap.className = "quality";
  for (const q of qualities) {
    const b = document.createElement("button");
    b.textContent = q.label;
    if (q.ratio === selectedRatio) b.classList.add("active");
    b.addEventListener("click", () => {
      selectedRatio = q.ratio;
      wrap.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
    });
    wrap.appendChild(b);
  }
  el.appendChild(wrap);

  const dl = document.createElement("button");
  dl.className = "btn-primary";
  dl.textContent = "下载视频";
  dl.addEventListener("click", async () => {
    const q = qualities.find((x) => x.ratio === selectedRatio) || qualities[0];
    const filename = buildVideoFilename(data.author, data.title, q.label);
    dl.disabled = true;
    dl.textContent = "下载中…";
    const resp = await sendMsg({ type: "download", url: q.url, filename });
    dl.disabled = false;
    dl.textContent = resp?.ok ? "已开始下载 ✓" : "下载失败,重试";
    if (resp?.ok) {
      setStatus("已开始下载, 请查看浏览器下载列表");
      setTimeout(() => (dl.textContent = "下载视频"), 2000);
    } else {
      setStatus(resp?.error || "下载失败");
    }
  });
  el.appendChild(dl);
}

function renderAlbum(el: HTMLElement, data: Extract<ParsedData, { type: "album" }>) {
  const grid = document.createElement("div");
  grid.className = "album-grid";
  for (const img of data.images) {
    const cell = document.createElement("div");
    const im = document.createElement("img");
    im.src = img.preview || img.url;
    cell.appendChild(im);
    grid.appendChild(cell);
  }
  el.appendChild(grid);

  const count = data.images.length;
  const dl = document.createElement("button");
  dl.className = "btn-primary";
  dl.textContent = `下载全部图片 (${count} 张)`;
  dl.addEventListener("click", async () => {
    dl.disabled = true;
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
      dl.textContent = `下载中… ${done}/${count}`;
      await sleep(700);
    }
    dl.disabled = false;
    dl.textContent = "全部已开始下载 ✓";
    setStatus("已开始下载, 请查看浏览器下载列表");
    setTimeout(() => (dl.textContent = `下载全部图片 (${count} 张)`), 2500);
  });
  el.appendChild(dl);
}

function setStatus(msg: string) {
  $("status").textContent = msg;
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
