/**
 * CesiumJS ships its Workers, Assets, Widgets and ThirdParty bundles as static
 * files that must be served over HTTP at runtime -- they are deliberately not
 * part of the JS module graph, so no bundler will emit them for us.
 *
 * We copy them into `public/cesium`, and the client sets
 * `window.CESIUM_BASE_URL = '/cesium'` before Cesium is imported.
 *
 * `public/cesium` is gitignored; this script runs on postinstall so a fresh
 * clone is ready after `npm install`.
 */
import { cp, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "cesium", "Build", "Cesium");
const target = join(root, "public", "cesium");

const DIRECTORIES = ["Workers", "Assets", "Widgets", "ThirdParty"];

try {
  await access(source);
} catch {
  console.warn("[cesium] node_modules/cesium not found - skipping asset copy.");
  process.exit(0);
}

await mkdir(target, { recursive: true });
for (const directory of DIRECTORIES) {
  await cp(join(source, directory), join(target, directory), {
    recursive: true,
    force: true,
  });
}

console.log(`[cesium] Copied static assets -> public/cesium`);
