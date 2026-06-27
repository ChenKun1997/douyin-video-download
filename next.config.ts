import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // 抖音的图片 CDN 不在 Next 默认优化白名单里,关闭图片优化直接走原图。
  // (封面图本身走 <img> 标签,这里只是声明策略)
  images: {
    unoptimized: true,
  },
  // 显式指定 workspace 根目录, 避免上级目录的 lockfile 触发推断警告
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
