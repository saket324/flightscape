import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Pin the workspace root: a stray lockfile in a parent directory would
  // otherwise make Turbopack infer the wrong project root.
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  // Cesium ships large pre-bundled ESM. Leaving it out of the server bundle
  // keeps `next build` from trying to statically analyse its worker loaders.
  serverExternalPackages: ["cesium"],
};

export default nextConfig;
