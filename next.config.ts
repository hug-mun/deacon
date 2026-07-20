import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Set NEXT_PUBLIC_BASE_PATH=/deacon when this app is mounted below hugmun.ai/deacon.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
};

export default nextConfig;
