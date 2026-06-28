/**
 * 下载代理接口
 *
 * GET /api/proxy?url=<视频地址>&filename=<文件名>&mode=redirect|stream
 *
 * ★ 为什么需要这个接口:
 *   抖音 play 地址 (aweme.snssdk.com/.../play/) 是一个会 302 跳转的"中转地址",
 *   浏览器里直接点 <a href> 下载会失败 —— 因为 play 地址要求带
 *   Referer: https://www.iesdouyin.com/, 否则拒绝。
 *
 * ★ 两种模式:
 *   - mode=redirect (默认): 服务端只做轻量"探路" —— 用正确的 Referer 请求 play
 *     地址拿到 302 后的【最终 CDN 地址】, 然后 302 把浏览器导向它。真正视频流
 *     由浏览器直连 CDN, Vercel 不转发任何字节。
 *       → 优点: 几百毫秒返回, 下载速度 = 浏览器直连 CDN, 不受 10s/带宽限制
 *   - mode=stream: 老式流式转发, 视频流经 Vercel。仅当 redirect 模式被 CDN
 *     拒绝(403)时的兜底。受 Vercel 10s 超时限制, 大文件会失败。
 *
 * 对应 Python 版 server.py:_handle_proxy
 */

import { NextRequest, NextResponse } from "next/server";
import { MOBILE_UA, HOMEPAGE_URL } from "@/lib/douyin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel Hobby plan 上限 10s; redirect 模式只需探路, 绰绰有余。
export const maxDuration = 10;

// 抖音/字节系 CDN 域名白名单 (SSRF 防护)
const ALLOWED = [
  "aweme.snssdk.com",
  ".snssdk.com",
  ".douyinpic.com",
  ".bytecdn.cn",
  ".byteimg.com",
  ".douyinvod.com",
  ".ixigua.com",
  ".bdurl.net",
  ".byteoss.com",
  ".amemv.com",
];

function isAllowedHost(hostname: string): boolean {
  return ALLOWED.some(
    (d) => hostname === d || hostname.endsWith(d),
  );
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const url = sp.get("url");
  const filename = sp.get("filename") || "video.mp4";
  const mode =
    sp.get("mode") === "image"
      ? "image"
      : sp.get("mode") === "stream"
        ? "stream"
        : "redirect";

  if (!url) {
    return NextResponse.json(
      { ok: false, error: "缺少 url 参数" },
      { status: 400 },
    );
  }

  let targetHost = "";
  try {
    targetHost = new URL(url).hostname;
  } catch {
    return NextResponse.json(
      { ok: false, error: "url 参数不是合法 URL" },
      { status: 400 },
    );
  }
  if (!isAllowedHost(targetHost)) {
    return NextResponse.json(
      { ok: false, error: `不允许的域名: ${targetHost}` },
      { status: 403 },
    );
  }

  const clientRange = req.headers.get("range");

  // ============ image 模式: 图片内联转发 (解决抖音图床在部分网络/地区无法直连) ============
  if (mode === "image") {
    return imageProxy(url);
  }

  // ============ redirect 模式: 探路 + 302 直连 ============
  if (mode === "redirect") {
    return resolveRedirect(url, filename);
  }

  // ============ stream 模式: 流式转发 (兜底) ============
  return streamProxy(url, filename, clientRange);
}

/**
 * image 模式: 服务端带 Referer 拉取抖音图床图片, 原样转发 Content-Type,
 * 以 inline 方式返回 (供 <img> 直接渲染)。
 *
 * 解决: 浏览器直连 p3-pc-sign.douyinpic.com 在部分网络/海外/CDN 节点 403 或超时。
 */
async function imageProxy(url: string) {
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: {
        "User-Agent": MOBILE_UA,
        Referer: HOMEPAGE_URL,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      redirect: "follow",
      cache: "no-store",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response("image fetch failed: " + msg, { status: 502 });
  }
  if (upstream.status !== 200) {
    return new Response(`image source HTTP ${upstream.status}`, {
      status: 502,
    });
  }
  const contentType = upstream.headers.get("content-type") || "image/jpeg";
  const cacheControl =
    upstream.headers.get("cache-control") || "public, max-age=86400";
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", cacheControl);
  headers.set("X-Proxy-Mode", "image");
  if (!upstream.body) {
    return new Response("image source empty", { status: 502 });
  }
  return new Response(upstream.body as ReadableStream<Uint8Array>, {
    status: 200,
    headers,
  });
}

/**
 * redirect 模式: 用正确 Referer 探出最终 CDN 地址, 302 给浏览器。
 *
 * 抖音 play 地址的行为:
 *   GET play?video_id=...   (需 Referer)
 *     → 302 Location: https://<cd>.douyinvod.com/...?签名参数
 *   最终 CDN 地址把鉴权签名编进 URL, 不再校验 Referer, 浏览器可直连。
 */
async function resolveRedirect(url: string, filename: string) {
  const headers: Record<string, string> = {
    "User-Agent": MOBILE_UA,
    Referer: HOMEPAGE_URL,
    // 只探地址, 不要正文 —— 用 Range 拿 1 字节, 避免下载整个视频
    Range: "bytes=0-0",
  };

  let resp: Response;
  try {
    // manual: 不自动跟跳, 以便从 Location 取最终 CDN 地址
    resp = await fetch(url, { headers, redirect: "manual" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: `连接 play 接口失败: ${msg}` },
      { status: 502 },
    );
  }

  // play 地址正常会返回 3xx -> Location 指向最终 CDN 地址。
  // 拿到 Location 才能安全地让浏览器直连; 否则 (200/其他) 说明该地址
  // 仍需 Referer 或已异常, 不能 302, 应由前端降级 stream 模式。
  const cdnUrl = [301, 302, 303, 307, 308].includes(resp.status)
    ? resp.headers.get("location")
    : null;

  if (!cdnUrl) {
    return NextResponse.json(
      {
        ok: false,
        error: `未能从 play 接口解析到 CDN 地址 (HTTP ${resp.status})`,
      },
      { status: 502 },
    );
  }

  // 安全校验: 最终 CDN 地址也必须在白名单内
  try {
    const cdnHost = new URL(cdnUrl).hostname;
    if (!isAllowedHost(cdnHost)) {
      return NextResponse.json(
        { ok: false, error: `CDN 地址不在白名单: ${cdnHost}` },
        { status: 502 },
      );
    }
  } catch {
    return NextResponse.json(
      { ok: false, error: "CDN 地址格式异常" },
      { status: 502 },
    );
  }

  // 302 把浏览器导向最终 CDN 地址, 文件名通过响应头提示 (部分浏览器支持)
  const redirectResp = NextResponse.redirect(cdnUrl, {
    status: 302,
    headers: {
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      // 让前端能识别这是 redirect 模式, 便于失败时切换 stream 模式
      "X-Proxy-Mode": "redirect",
    },
  });
  return redirectResp;
}

/**
 * stream 模式: 服务端流式转发视频流 (兜底, 受 10s 超时限制)。
 */
async function streamProxy(
  url: string,
  filename: string,
  clientRange: string | null,
) {
  const headers: Record<string, string> = {
    "User-Agent": MOBILE_UA,
    Referer: HOMEPAGE_URL,
    Range: clientRange || "bytes=0-",
  };

  let upstream: Response;
  try {
    upstream = await fetch(url, { headers, redirect: "follow" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: `连接 CDN 失败: ${msg}` },
      { status: 502 },
    );
  }

  if (upstream.status !== 200 && upstream.status !== 206) {
    return NextResponse.json(
      { ok: false, error: `CDN 返回 HTTP ${upstream.status}` },
      { status: 502 },
    );
  }

  const contentType = upstream.headers.get("content-type") || "video/mp4";
  const contentLength = upstream.headers.get("content-length");
  const contentRange = upstream.headers.get("content-range");
  const acceptRanges = upstream.headers.get("accept-ranges") || "bytes";

  const respHeaders = new Headers();
  respHeaders.set("Content-Type", contentType);
  respHeaders.set("Accept-Ranges", acceptRanges);
  if (contentRange) respHeaders.set("Content-Range", contentRange);
  if (contentLength) respHeaders.set("Content-Length", contentLength);
  const quoted = encodeURIComponent(filename);
  respHeaders.set(
    "Content-Disposition",
    `attachment; filename="video.mp4"; filename*=UTF-8''${quoted}`,
  );
  respHeaders.set("X-Proxy-Mode", "stream");

  if (!upstream.body) {
    return NextResponse.json(
      { ok: false, error: "CDN 未返回响应体" },
      { status: 502 },
    );
  }

  return new Response(upstream.body as ReadableStream<Uint8Array>, {
    status: upstream.status === 206 ? 206 : 200,
    headers: respHeaders,
  });
}
