/**
 * 用户解析接口
 *
 * POST /api/user/resolve
 *   body: { input: string }   // 主页链接 / 短链 / sec_uid / 数字 short_id / 抖音号
 *   resp: { ok: true, profile: UserProfile } | { ok: false, error: string }
 *
 * 把任意用户输入解析为 sec_uid, 并返回昵称/头像/作品数, 供前端展示。
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveSecUid, getUserProfile } from "@/lib/douyin-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let payload: { input?: string } = {};
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "请求体不是合法 JSON" },
      { status: 400 },
    );
  }

  const input = (payload.input || "").trim();
  if (!input) {
    return NextResponse.json(
      { ok: false, error: "请输入用户主页链接、sec_uid 或抖音号" },
      { status: 400 },
    );
  }

  try {
    const secUid = await resolveSecUid(input);
    const profile = await getUserProfile(secUid);
    return NextResponse.json({ ok: true, profile });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isUserError =
      msg.includes("输入") ||
      msg.includes("解析") ||
      msg.includes("找到") ||
      msg.includes("识别") ||
      msg.includes("短链") ||
      msg.includes("已失效") ||
      msg.includes("主页链接") ||
      msg.includes("登录态") ||
      msg.includes("解析「");
    return NextResponse.json(
      { ok: false, error: msg },
      { status: isUserError ? 400 : 500 },
    );
  }
}
