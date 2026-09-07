import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Vercel's Next adapter does not consume the standalone trace and Next 16.3
  // intentionally omits the root NFT when an adapter is active. Keep the
  // standalone artifact for Docker while leaving native Vercel packaging on
  // its supported path.
  output: process.env.VERCEL ? undefined : "standalone",
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
