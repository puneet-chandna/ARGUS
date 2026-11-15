import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  experimental: { useTypeScriptCli: true },
  poweredByHeader: false,
  agentRules: false,
};

export default config;
