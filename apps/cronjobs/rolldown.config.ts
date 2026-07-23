import { builtinModules } from "node:module";
import { defineConfig } from "rolldown";

// Bundle each cronjob entrypoint and its npm/workspace deps into a single minified
// ESM file so the runtime image ships `dist/*.js` instead of the whole monorepo
// `node_modules` + tsx. Only node builtins stay external.
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
    input: {
        "billing-invoicer": "scripts/vercel-billing-invoicer/index.ts",
        "usage-reporter": "scripts/vercel-usage-reporter/index.ts",
        "usage-meter": "scripts/preview-usage-meter/index.ts",
    },
    output: {
        dir: "dist",
        format: "esm",
        sourcemap: true,
        entryFileNames: "[name].js",
        minify: true,
    },
    platform: "node",
    external: nodeBuiltins,
});
