import { builtinModules } from "node:module";
import { defineConfig } from "rolldown";

// Bundle the one-shot Job runner (src/runner/index.ts) and all its npm/workspace
// deps into a single minified ESM file so the runtime image ships `dist/index.js`
// instead of the whole monorepo `node_modules` + tsx. Only node builtins stay
// external; everything else (AWS SDK, @kubernetes/client-node, @autonoma/*, the
// Prisma client) is inlined.
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
    input: { index: "src/runner/index.ts" },
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
