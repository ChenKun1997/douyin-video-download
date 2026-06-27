/**
 * 解析抖音链接接口
 *
 * POST /api/parse
 *   body: { text: string }
 *   resp: { ok: true, data: ParseResult } | { ok: false, error: string }
 *
 * 对应 Python 版 server.py:_handle_parse
 */

import { NextRequest, NextResponse } from "next/server";
import { parseDouyin } from "@/lib/douyin";

// 用 Node.js runtime 以使用 Node 的 fetch (可自由设 Referer/UA)。
// Vercel Hobby plan: 函数最长 10s, 解析 1~3s 足够。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let payload: { text?: string } = {};
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "请求体不是合法 JSON" },
      { status: 400 },
    );
  }

  const text = (payload.text || "").trim();
  if (!text) {
    return NextResponse.json(
      { ok: false, error: "请输入抖音链接或分享文案" },
      { status: 400 },
    );
  }

  try {
    const data = await parseDouyin(text);
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 区分: 用户输入问题 (400) vs 服务端问题 (500)
    const isUserError =
      msg.includes("输入") ||
      msg.includes("找到链接") ||
      msg.includes("视频 ID") ||
      msg.includes("分享页请求失败");
    return NextResponse.json(
      { ok: false, error: msg },
      { status: isUserError ? 400 : 500 },
    );
  }
}
