import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",

    // Cesium's pre-built Workers, Assets and Widgets are copied into public/
    // by the postinstall script. They are vendored third-party output rather
    // than our source, and linting them buries real findings under thousands
    // of meaningless ones.
    "public/cesium/**",
  ]),
]);

export default eslintConfig;
