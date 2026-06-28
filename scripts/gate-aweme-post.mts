/**
 * 阶段 0 验证门: 验证自实现 a_bogus 签名能否让抖音 aweme/post 接口返回数据。
 * 用法: npx tsx scripts/gate-aweme-post.mts
 * 仅用于开发期验证, 不参与生产构建。
 */
import { signedRequest } from "../lib/douyin-web.ts";

// 公开账号 sec_uid (仅用于冒烟测试)
const SEC_UID = "MS4wLjABAAAArDVBosPJF3eIWVEFp0szuJ-e1V_-rK0ieJeWwpE77E8";

async function main() {
  const r = await signedRequest({
    path: "/aweme/v1/web/aweme/post/",
    params: {
      sec_user_id: SEC_UID,
      count: 5,
      max_cursor: 0,
      locate_query: "false",
      publish_video_strategy_type: 2,
      need_time_list: 1,
      time_list_query: 0,
      whale_cut_token: "",
      cut_version: 1,
      from_user_page: 1,
    },
    method: "GET",
  });

  console.log("ok     :", r.ok);
  console.log("status :", r.status);
  console.log("error  :", r.error);

  if (r.ok && r.data) {
    const d = r.data as any;
    console.log("status_code   :", d.status_code);
    console.log("has_more      :", d.has_more);
    console.log("aweme_list len:", (d.aweme_list || []).length);
    if (d.aweme_list && d.aweme_list[0]) {
      const a = d.aweme_list[0];
      console.log("first aweme_id:", a.aweme_id);
      console.log("first desc    :", (a.desc || "").slice(0, 40));
      console.log("first author  :", a.author && a.author.nickname);
    }
  }
}

main().catch((e) => {
  console.error("GATE THREW:", e);
  process.exit(1);
});
