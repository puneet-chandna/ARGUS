import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  experimental: { useTypeScriptCli: true },
  poweredByHeader: false,
  devIndicators: false,
  agentRules: false,
  productionBrowserSourceMaps: process.env.ARGUS_COVERAGE === "1",
};

export default config;
