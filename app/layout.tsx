import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "抖音无水印下载",
  description: "粘贴分享文案或链接，一键解析无水印视频",
};

// viewport 单独导出: 含 viewport-fit=cover 才能让 iOS 安全区 (env(safe-area-inset-*)) 生效
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0f0f14",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
