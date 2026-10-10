import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * 关掉开发模式左下角那个浮动的 Next.js 开发工具指示器。
   * 它是 Next 自带的调试角标（全英文，只在 dev 下出现），和本应用的功能无关 ——
   * 界面上留一个英文小圆标容易让人以为是我们的按钮。
   */
  devIndicators: false,

  /**
   * Quirex 是一个**本地工具**：题库放在用户自己的 Obsidian Vault 里
   * （路径由 VAULT_PATH / config.json 在运行期决定），模板目录与导出目录同理。
   *
   * 这些路径都不是应用的一部分，而是在运行期从文件系统读取的数据。但 Next 的
   * 静态文件追踪（NFT）看到 `process.cwd() + fs` 这类动态路径时无法判定范围，
   * 会把整个项目纳入 trace 并给出 "the whole project was traced" 构建警告。
   *
   * 我们不做 serverless 部署（导出要调用本机 xelatex），所以文件追踪在这里没有意义，
   * 直接关掉，构建输出保持干净。
   */
  outputFileTracingExcludes: {
    "*": ["**/*"],
  },
};

export default nextConfig;
