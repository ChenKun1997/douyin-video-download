# 抖音无水印视频下载工具

一个零依赖的抖音无水印视频下载工具，支持两种下载模式，提供两种使用方式：

- **Next.js + Vercel 版（推荐）**：一键部署到 Vercel 免费版，无需维护服务器，全球可访问
- **Python 本地版**：零依赖命令行 / 本地 Web 服务，开箱即用

## 特性

- **两种下载模式**（顶部 tab 切换）：
  - **单个视频**：粘贴分享文案/链接，解析后下载（支持视频 **和图集**）
  - **用户主页**：输入用户主页链接 / sec_uid，拉取该用户的作品，可批量勾选下载
- **图集支持**：图文作品自动识别，预览全部无水印原图，一键打包下载 ZIP（零依赖 STORE 模式）
- **无水印**：通过解析抖音移动端分享页，拿到带 `watermark=0` 的播放地址 / 原图
- **多清晰度**：视频支持 1080P / 720P / 540P 切换
- **支持多种链接格式**：
  - 短链：`https://v.douyin.com/xxxxx/`
  - 长链：`https://www.douyin.com/video/123456`
  - 完整分享文案：直接粘贴 App 里复制的内容，自动提取链接
  - 用户主页：`https://www.douyin.com/user/MS4w...`、裸 `sec_uid`、分享短链
- **登录态可选**：用户主页模式可填抖音 Cookie 解锁「下载全部作品」（匿名仅最近 ~41 个）
- **文件名自动命名**：`作者_视频标题_清晰度.mp4`，自动清洗非法字符
- **本地历史记录**（Web 版）：localStorage 存储最近 30 条，可重新下载/删除
- **快捷键**：输入框内按 `Ctrl/Cmd + Enter` 快速解析

---

## 方式一：Next.js 版（部署到 Vercel）

### 部署到 Vercel（一键，推荐）

1. 把本仓库推到 GitHub
2. 打开 [vercel.com](https://vercel.com)，用 GitHub 登录，点 **Add New → Project**
3. 选择该仓库，框架选 **Next.js**（Vercel 会自动识别），直接 **Deploy**
4. 等待约 1 分钟，部署完成即可访问

> 免费的 Hobby plan 即可使用，无需绑定信用卡。

### 本地开发

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # 生产构建
npm run start    # 本地跑生产版本
```

### 文件结构

```
.
├── app/
│   ├── api/parse/route.ts        # 单视频解析接口 (短链→aweme_id→分享页→清晰度)
│   ├── api/proxy/route.ts        # 流式代理下载 (带 Referer, 规避跨域)
│   ├── api/user/resolve/route.ts # 用户解析接口 (主页链接/短链/sec_uid/抖音号→sec_uid+资料)
│   ├── api/user/videos/route.ts  # 用户作品列表接口 (单页, 前端循环分页)
│   ├── globals.css               # 样式
│   ├── layout.tsx
│   └── page.tsx                  # 主页面 (模式切换: 单视频/用户主页)
├── lib/
│   ├── douyin.ts                 # 单视频解析核心 (对应 Python 版)
│   ├── sm3.ts                    # SM3 哈希 (a_bogus 签名依赖)
│   ├── abogus.ts                 # a_bogus 请求签名 (移植自 f2, 易失效)
│   ├── douyin-web.ts             # web 接口客户端 (ttwid/msToken + 签名请求 + 可选登录cookie)
│   ├── douyin.ts                 # 单视频/图集解析 (分享页 _ROUTER_DATA)
│   ├── douyin-user.ts            # 用户: resolveSecUid + 作品分页
│   └── zip.ts                    # 零依赖 ZIP 打包 (STORE 模式, 供图集打包下载)
├── next.config.ts
├── package.json
└── tsconfig.json
```

### 用户主页模式工作原理

「单个视频」走 iesdouyin 移动端分享页（无需签名）。「用户主页」则需要拉取
该用户的全部作品，这只能通过抖音 web 接口 `/aweme/v1/web/aweme/post/` 实现，
**该接口强制要求 `a_bogus` 请求签名**（抖音的 JSVMP/SM3 签名方案）。

本工具**自实现**签名（零第三方 API、零 API key），核心在 `lib/abogus.ts`：

1. **解析用户**：主页长链/裸 sec_uid 正则直接取；v.douyin 短链跟随重定向取；
   数字 short_id/抖音号 走签名搜索接口反查。
2. **匿名 token**：通过 passport 接口匿名获取 `ttwid` cookie（无需登录），
   `msToken` 用随机串，缓存 30 分钟。
3. **签名 + 拉取**：对请求用 `a_bogus` 签名，单次 `count=50` 拿满抖音
   匿名接口上限（~41 条）。**注意**：抖音匿名访问下 `cursor` 分页不可用，
   因此无法获取更早的作品（详见下方限制说明）。
4. **下载**：列表中每个视频提取 `video_id`，构造无水印 play 地址，复用 `/api/proxy`
   的 redirect 模式（302 直连 CDN），与单视频下载完全一致。

> ⚠️ **已知维护成本**：抖音会周期性轮换签名算法（如历史上的
> X-Bogus → a_bogus），届时 `lib/abogus.ts` 会失效，需要重新移植。
> 此外抖音对**连续翻页有风控**，加载更多若失败请稍等几秒后重试。
> 单个视频的下载不受影响（走无签名的分享页路径）。

> ⚠️ **关于「下载全部视频」的客观限制**：经实测（含 f2 权威实现对照），
> 抖音 web `aweme/post` 接口在**匿名（纯签名、无登录态）访问**下：
> - 单用户无论 `count` 多大，**最多返回约 41 条作品**
> - `cursor` 分页（`max_cursor≠0`）一律返回空，**无法翻页**
>
> 这是抖音的反爬机制。**解决办法**：在用户主页模式填入你的抖音登录 Cookie
> （见下「图集 & 登录态」），即可翻页拿全部作品。匿名模式下已把 `count`
> 调到 50 拿满上限（~41 个）。

### 图集 & 登录态（cookie）

**图集（图文作品）**：单视频模式会自动识别图集，预览全部无水印原图（取
`images[].download_url_list[0]`，最高清原图），一键「打包下载 ZIP」。
ZIP 打包是零依赖的 STORE 模式实现（`lib/zip.ts`），图片已是压缩格式不二次压缩。

**登录 Cookie（解锁翻页拿全部作品）**：用户主页模式顶部「🔒 匿名模式」点击展开，
粘贴你的抖音登录 Cookie 即可解锁翻页：

1. 电脑浏览器登录 `www.douyin.com`
2. F12 → Application/Network → 复制整段 Cookie（需含 `sessionid`、`ttwid` 等）
3. 粘到「登录 Cookie」输入框 → 保存

Cookie 仅存在**本机 localStorage**，随请求头发给后端用于本次拉取，不在服务器持久化。
填了 Cookie 后可「加载更多」翻页拿全部作品。

### 工作原理（与 Python 版的差异）

解析流程与 Python 版完全一致：

1. **提取链接**：从分享文案中用正则提取 `http(s)` 链接
2. **解析 ID**：跟随短链重定向，得到视频唯一 ID（`aweme_id`）
3. **请求分享页**：访问移动端分享页 `iesdouyin.com/share/video/{id}/`，伪装 iPhone Safari UA + `Referer`，从内嵌 `_ROUTER_DATA` JSON 提取视频信息
4. **构造无水印地址**：用 `/play/` 而非 `/playwm/`，按 `ratio` 参数切换清晰度
5. **下载**：视频 CDN 必须带 `Referer` 鉴权，浏览器无法直接访问，由 `/api/proxy` 流式代理转发

**与 Python 版的关键区别**：

| 机制 | Python 版 | Next.js 版 | 原因 |
|------|-----------|------------|------|
| DoH + SNI 直连 | ✅ 有 | ❌ 去掉 | DoH 只为绕过**用户本地** DNS 污染；Vercel 服务器用干净 DNS，无需此机制 |
| 伪造 Referer/UA | ✅ | ✅ | 抖音 CDN 鉴权依赖，Node 端可自由设置 |
| 流式下载代理 | ✅ | ✅ | 规避浏览器跨域 + 加 Referer |

### ⚠️ Vercel 免费版的限制

| 限制项 | 值 | 影响 |
|--------|-----|------|
| 函数执行时长 | **最长 10 秒**（Hobby）/ 60 秒（Pro） | 大 1080P 视频可能下载超时中断 |
| 每月带宽 | 100 GB | 个人用够；高频分享会超 |
| 每月函数调用 | 100 万次 | 一般够用 |

**下载超时怎么办？** 页面上的"复制无水印链接"按钮会复制直链，可用 IDM、aria2 等支持自定义 `Referer: https://www.iesdouyin.com/` 的下载工具离线下载。

### 常见问题（Next.js 版）

**Q: 本地 `npm run dev` 解析报错 `fetch failed`，但部署到 Vercel 正常？**
A: 这是**本地 DNS 污染**导致（中国大陆部分网络会污染 `iesdouyin.com` 等域名的解析）。Vercel 服务器用干净 DNS，不受影响。本地测试可通过配置代理（`HTTPS_PROXY`）或直接部署到 Vercel 验证。

**Q: 下载的大视频不完整？**
A: 命中了 Vercel 免费版的 10 秒超时。改用"复制直链"+下载工具，或升级 Pro plan。

---

## 方式二：Python 本地版（零依赖）

仅使用 Python 标准库，无需 `pip install`。

### Web 界面

```bash
python3 server.py                 # 启动并自动打开浏览器
python3 server.py --port 9000     # 指定端口
python3 server.py --no-open       # 不自动打开浏览器
```

### 命令行

```bash
# 短链 / 长链 / 直接粘贴整段分享文案
python3 douyin_download.py "https://v.douyin.com/xxxxx/"
python3 douyin_download.py "7.99 复制打开抖音，看看【作者的作品】 https://v.douyin.com/xxxxx/ ..."

python3 douyin_download.py "链接" -o ./videos    # 指定输出目录
python3 douyin_download.py "链接" --info         # 仅查看信息不下载
python3 douyin_download.py "链接" --quality 1080p  # 指定清晰度
```

视频默认保存在 `./downloads/` 目录。

> Python 版内置 **DoH + SNI 直连**，可绕过本地 DNS 污染，适合在 DNS 被污染的网络环境下使用。

---

## 法律与使用须知

本工具仅供**个人学习与研究**使用。下载的视频版权归原作者所有，请勿用于
商业用途或二次传播。使用本工具产生的任何法律责任由使用者自行承担。
