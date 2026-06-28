# scripts/

开发期验证脚本 (不参与生产构建, 仅本地用 `npx tsx` 运行)。

- `gate-aweme-post.mts` — 阶段0 验证: 自实现 a_bogus 能否让 aweme/post 返回数据
- `gate-user.mts`        — 阶段1 验证: resolveSecUid / getUserProfile / 分页 / play_url 提取

运行:
```bash
npx tsx scripts/gate-aweme-post.mts
npx tsx scripts/gate-user.mts
```
