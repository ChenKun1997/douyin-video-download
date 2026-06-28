import { fetchUserVideoPage, getUserProfile } from "../lib/douyin-user.ts";

const SEC = "MS4wLjABAAAArDVBosPJF3eIWVEFp0szuJ-e1V_-rK0ieJeWwpE77E8";
async function main() {
  const [page, profile] = await Promise.all([
    fetchUserVideoPage(SEC, 0),
    getUserProfile(SEC),
  ]);
  // 输出到两行, 供 shell 读取
  console.log(page.items[0]?.cover_url || "");
  console.log(profile.avatar_url || "");
}
main().catch((e) => console.error(e));
