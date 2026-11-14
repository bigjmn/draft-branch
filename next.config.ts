import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The editor is browser-local today. Standard `next build` / `next start`
  // remain available; Sites requests a static export through this flag.
  output: process.env.SITES_STATIC_EXPORT === "1" ? "export" : undefined,
  reactStrictMode: true,
};
export default nextConfig;
