import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The world engine is an imperative singleton wired to the canvas lifecycle;
  // strict-mode double-mounting would dispose it mid-boot in dev.
  reactStrictMode: false,
};

export default nextConfig;
