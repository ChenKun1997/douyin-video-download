# 抖音无水印下载 · 浏览器插件

基于本项目核心解析逻辑(iesdouyin 分享页路径)打包的 Chrome / Edge
**Manifest V3** 扩展。**不依赖任何服务器**——解析与下载全部在浏览器本地完成。

- 在抖音**任意页面**(推荐流 / 首页 / 视频详情 / 图集)右下角注入「无水印下载」浮动按钮
- 工具栏弹窗可粘贴分享文案 / 短链 / 长链解析下载
- 视频支持 1080P / 720P / 540P 切换
- 图集(图文)自动识别,逐张下载全部原图
- 文件名自动命名:`作者_标题_清晰度.mp4` / `作者_标题_01.webp`

> 与 web 版的区别:web 版经 Vercel 函数代理(有 10s 超时);插件用
> `declarativeNetRequest` 直接给抖音 CDN 注入 `Referer` 后由浏览器直连,
> **无超时、无带宽限制、零服务器成本**。

## 安装

1. 构建插件:
   ```bash
   npm install
   npm run ext          # 构建 → extension/dist/
   ```
2. 打开 `chrome://extensions`(或 Edge 的 `edge://extensions`)
3. 右上角开启 **「开发者模式」**
4. 点 **「加载已解压的扩展程序」**,选择本项目的 **`extension/`** 目录
5. 访问任意抖音视频 / 图集页,右下角即出现下载按钮

## 使用

**方式一:页面注入(推荐)**
- 打开 `https://www.douyin.com/video/{id}`(普通视频)或
  `https://www.douyin.com/note/{id}`(图集)
- 点右下角红色「无水印下载」按钮 → 弹出预览面板
- 视频:选清晰度 → 下载;图集:「下载全部图片」

**方式二:工具栏弹窗**
- 点浏览器工具栏的插件图标
- 粘贴抖音 App 里复制的分享文案 / 短链 / 长链(支持整段文案,自动提取链接)
- 点「解析」→ 预览 → 下载

## 构建 / 开发

```bash
npm run ext        # 构建(带 sourcemap, 不压缩)
npm run ext:dev    # 监听模式, 改动自动重新打包
npm run ext:prod   # 压缩版(发布前用)

node scripts/make-icons.mjs   # 重新生成占位图标
```

> 加载扩展时根目录是 `extension/`(包含 `manifest.json`),构建产物在
> `extension/dist/`。修改 `src/*.ts` 后重新 `npm run ext`,再到
> `chrome://extensions` 点插件的「重新加载」按钮即可。

## 工作原理

```
页面 / popup
  │  chrome.runtime.sendMessage
  ▼
background service worker
  │  fetch iesdouyin 分享页 (Referer/UA 由 DNR 注入)
  │  复用 douyin-ext.ts 解析: _ROUTER_DATA → walkFind → isAlbum?
  ▼
解析结果 → 预览面板
  │  点下载
  ▼
chrome.downloads.download (DNR 给 aweme.snssdk.com 注入 Referer)
```

**关键点**:
- **解析核心**(`douyin-ext.ts`)从根目录 `lib/douyin.ts` 派生,保留全部纯解析
  逻辑(括号深度匹配 `_ROUTER_DATA`、递归 `walkFind`、图集 `isAlbum`/`getAlbumImages`)。
- **不依赖 a_bogus 签名**:走 iesdouyin 无签名分享页路径,是抖音最稳定的下载方式,
  不受签名算法轮换影响。
- **Referer/UA 注入**:浏览器 service worker 无法设置 forbidden header
  (`User-Agent`/`Referer`),改由 `manifest.json` 的 `declarativeNetRequest`
  静态规则(`src/rules.json`)在请求发出前注入。

## 文件结构

```
extension/
├── manifest.json          # MV3 清单 (host_permissions / content_scripts / DNR)
├── popup.html             # 工具栏弹窗 UI
├── icons/                 # 16/48/128 图标 (占位)
├── src/
│   ├── douyin-ext.ts      # 解析核心 (派生自 lib/douyin.ts, 改造 HTTP 层)
│   ├── background.ts      # service worker: parse / download 消息处理
│   ├── content.ts         # 页面注入: 浮动按钮 + 预览面板 (ShadowRoot 隔离)
│   ├── popup.ts           # 工具栏弹窗逻辑
│   ├── types.ts           # 共享消息协议与类型
│   └── rules.json         # declarativeNetRequest 静态规则
└── dist/                  # 构建产物 (gitignore)
```

## 常见问题

**Q: 点下载后文件名变成一串乱码或 `.crdownload`?**
A: 浏览器下载进行中的临时扩展名,下载完成后会恢复 `.mp4`。若卡住,检查
`chrome://extensions` 里插件是否报错(尤其是 DNR 规则是否生效)。

**Q: 解析失败 / 提示「无法解析页面数据」?**
A: 抖音分享页结构变更会导致 `extractRouterData` 失效,需更新 `douyin-ext.ts`
(对照根目录 `lib/douyin.ts`)。单视频路径历史最稳定,极少变动。

**Q: 刷推荐流/首页时没有下载按钮,或按钮不出现?**
A: 推荐流的当前视频 id 不在 URL 里,插件靠 DOM 选择器
`[data-e2e="feed-active-video"]` 的 `data-e2e-vid` 属性取 id。
若抖音改版换了 `data-e2e` 值,按钮就不会出现。自查方法:

1. F12 打开开发者工具,在 Elements 面板搜 `feed-active-video`
2. 若该属性名已变(如改成 `feed-active` 等),编辑 `extension/src/content.ts`
   顶部的 `ACTIVE_VIDEO_SEL` 常量,`npm run ext` 重新构建,再在
   `chrome://extensions` 点插件的「重新加载」

> 直链打开 `/video/{id}` 或 `/note/{id}` 不受此影响(走 URL 取 id 的兜底分支)。

## 法律与使用须知

同根目录主 README:仅供**个人学习与研究**使用,下载内容版权归原作者所有,
请勿用于商业用途或二次传播。
