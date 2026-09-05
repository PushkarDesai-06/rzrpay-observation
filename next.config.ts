import type { NextConfig } from "next";

const config: NextConfig = {
  // The recovery core is plain Node: it opens SQLite through the `node:sqlite`
  // builtin and must never be bundled for the browser.
  serverExternalPackages: ["razorpay"],
  typescript: { ignoreBuildErrors: false },
};

export default config;
