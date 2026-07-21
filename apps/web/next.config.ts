import type { NextConfig } from "next";

// When STATIC_EXPORT=1 the app is built as a fully static site (`out/`), which
// deploys to any static host with zero config (Vercel, Netlify, Cloudflare
// Pages, S3, …). The frontend is a client-side SPA that talks to the API over
// HTTP, so nothing server-side is lost. Without the flag it builds normally,
// keeping the door open for SSR later.
const staticExport = process.env.STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  ...(staticExport
    ? { output: "export", images: { unoptimized: true }, trailingSlash: true }
    : {}),
};

export default nextConfig;
