/**
 * Stage 1 验证: 解析 sec_uid / 资料 / 作品分页 / play_url 提取。
 */
import {
  resolveSecUid,
  getUserProfile,
  fetchUserVideoPage,
} from "../lib/douyin-user.ts";

async function main() {
  const SEC_UID = "MS4wLjABAAAArDVBosPJF3eIWVEFp0szuJ-e1V_-rK0ieJeWwpE77E8";

  // 1. 解析 (各种输入)
  for (const input of [
    "MS4wLjABAAAArDVBosPJF3eIWVEFp0szuJ-e1V_-rK0ieJeWwpE77E8",
    `https://www.douyin.com/user/${SEC_UID}`,
  ]) {
    const sec = await resolveSecUid(input);
    console.log("resolveSecUid ok:", sec === SEC_UID ? "MATCH" : "DIFFERENT", "|", sec.slice(0, 30) + "...");
  }

  // 2. 资料
  const profile = await getUserProfile(SEC_UID);
  console.log("profile:", profile.nickname, "| aweme_count:", profile.aweme_count, "| short_id:", profile.short_id, "| avatar:", !!profile.avatar_url);

  // 3. 分页: 取前 2 页
  let cursor = 0;
  let total = 0;
  for (let page = 0; page < 2; page++) {
    const p = await fetchUserVideoPage(SEC_UID, cursor);
    console.log(`page ${page + 1}: got ${p.items.length} items, has_more=${p.has_more}, next_cursor=${p.max_cursor}`);
    if (p.items[0]) {
      const v = p.items[0];
      console.log(`  sample: id=${v.aweme_id} dur=${v.duration}s video_id=${v.video_id} cover=${!!v.cover_url} play_url=${v.play_url ? v.play_url.slice(0, 50) + "..." : "NULL"}`);
    }
    total += p.items.length;
    if (!p.has_more) break;
    cursor = p.max_cursor;
  }
  console.log("total fetched:", total);
}

main().catch((e) => {
  console.error("STAGE1 THREW:", e);
  process.exit(1);
});
