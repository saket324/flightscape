import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Cesium ships large pre-bundled ESM. Leaving it out of the server bundle
  // keeps `next build` from trying to statically analyse its worker loaders.
  serverExternalPackages: ["cesium"],
  eslint: {
    dirs: ["src", "scripts"],
  },
};

export default nextConfig;
