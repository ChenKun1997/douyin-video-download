/**
 * 用户作品列表接口 (单页)
 *
 * GET /api/user/videos?sec_uid=<>&cursor=<>
 *   header: X-Douyin-Cookie (可选, 登录态 cookie, 解锁翻页拿全部作品)
 *   resp: { ok: true, page: VideoPage } | { ok: false, error: string }
 *
 * 匿名: 单用户最多 ~41 条, 不能翻页。
 * 登录态 (带 cookie): 可 cursor 翻页拿全部作品 (前端循环调用)。
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchUserVideoPage } from "@/lib/douyin-user";
import { setUserCookie } from "@/lib/douyin-web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const secUid = (sp.get("sec_uid") || "").trim();
  const cursorRaw = (sp.get("cursor") || "0").trim();
  const countRaw = (sp.get("count") || "").trim();
  if (!secUid) {
    return NextResponse.json(
      { ok: false, error: "缺少 sec_uid 参数" },
      { status: 400 },
    );
  }
  const cursor = Number.isNaN(Number(cursorRaw)) ? 0 : Number(cursorRaw);
  const count = countRaw && !Number.isNaN(Number(countRaw)) ? Number(countRaw) : undefined;

  // 可选注入登录 cookie (解锁翻页)
  setUserCookie(req.headers.get("x-douyin-cookie"));

  try {
    const page = await fetchUserVideoPage(secUid, cursor, count);
    return NextResponse.json({ ok: true, page });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isRisk = /风控|签名|412/i.test(msg);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: isRisk ? 429 : 500 },
    );
  } finally {
    setUserCookie(null);
  }
}

