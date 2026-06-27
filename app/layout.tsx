import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "抖音无水印下载",
  description: "粘贴分享文案或链接，一键解析无水印视频",
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
