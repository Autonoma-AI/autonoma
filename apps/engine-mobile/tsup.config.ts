import { cpSync } from "node:fs";
import { builtinModules } from "node:module";
import { defineConfig } from "tsup";

const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
    entry: {
        index: "src/execution-agent/generation-api/run-generation-job.ts",
    },
    format: ["esm"],
    target: "node24",
    outDir: "dist",
    clean: true,
    sourcemap: true,
    minify: true,
    splitting: false,
    bundle: true,
    noExternal: [/.*/],
    external: [
        ...nodeBuiltins,
        // Prisma uses generated code with dynamic imports
        /^@prisma\//,
        /^\.\/generated\//,
        // pg adapter needs native pg driver
        "pg",
        "webdriverio",
    ],
    platform: "node",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    onSuccess: async () => {
        cpSync("../../packages/engine/src/execution-agent/agent/system-prompt.md", "dist/system-prompt.md");
    },
});
