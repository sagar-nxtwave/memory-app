import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Increase body size limit for document uploads — default 10MB is too small for real PDFs
  experimental: {
    proxyClientMaxBodySize: 500 * 1024 * 1024, // 500 MB
  },
  // These packages use Node.js native APIs — prevent webpack from trying to bundle them
  serverExternalPackages: ['pdf-parse', 'mammoth', 'xlsx'],
};

export default nextConfig;
