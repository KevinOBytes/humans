import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  output: "standalone",
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
