import { fetchUserVideoPage, getUserProfile } from "../lib/douyin-user.ts";

const SEC = "MS4wLjABAAAArDVBosPJF3eIWVEFp0szuJ-e1V_-rK0ieJeWwpE77E8";

async function main() {
  const [page, profile] = await Promise.all([
    fetchUserVideoPage(SEC, 0),
    getUserProfile(SEC),
  ]);
  const cover = page.items[0]?.cover_url;
  const avatar = profile.avatar_url;
  const targets: [string, string][] = [
    ["avatar", avatar!],
    ["cover", cover!],
  ];
  for (const [name, url] of targets) {
    // 模拟真实浏览器: 带 localhost referer + Origin + Sec-Fetch
    const r1 = await fetch(url, {
      headers: {
        Referer: "http://localhost:3000/",
        Origin: "http://localhost:3000",
        "Sec-Fetch-Site": "cross-site",
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      },
    });
    console.log(
      name,
      "带localhost referer:",
      r1.status,
      r1.headers.get("content-type"),
    );
    // no-referrer 场景
    const r2 = await fetch(url, { headers: { Accept: "image/*" } });
    console.log(
      name,
      "无referer            :",
      r2.status,
      r2.headers.get("content-type"),
    );
  }
}
main().catch((e) => console.error(e));
