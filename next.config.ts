import type { NextConfig } from "next";

const staticExport = process.env.CAPACITOR_STATIC === "1";

const nextConfig: NextConfig = {
  devIndicators: false,
  ...(staticExport
    ? {
        output: "export" as const,
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
