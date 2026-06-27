/**
 * 用户作品列表接口 (单页)
 *
 * GET /api/user/videos?sec_uid=<>&cursor=<>
 *   resp: { ok: true, page: VideoPage } | { ok: false, error: string }
 *
 * 每次只取一页 (≤18 条), 由前端循环调用直到 has_more=false。
 * 这样设计是为了规避 Vercel 函数时长限制, 且每个函数调用很快返回。
 *
 * ⚠️ 抖音对连续分页有风控: 前端应在每页之间加适当间隔 (1~2s),
 *    并在收到风控错误时提示用户稍后再试。
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchUserVideoPage } from "@/lib/douyin-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const secUid = (sp.get("sec_uid") || "").trim();
  const cursorRaw = (sp.get("cursor") || "0").trim();
  if (!secUid) {
    return NextResponse.json(
      { ok: false, error: "缺少 sec_uid 参数" },
      { status: 400 },
    );
  }
  const cursor = Number.isNaN(Number(cursorRaw)) ? 0 : Number(cursorRaw);

  try {
    const page = await fetchUserVideoPage(secUid, cursor);
    return NextResponse.json({ ok: true, page });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isRisk = /风控|签名|412/i.test(msg);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: isRisk ? 429 : 500 },
    );
  }
}
