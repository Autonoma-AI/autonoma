import { builtinModules } from "node:module";
import { defineConfig } from "tsup";

const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
    entry: { index: "src/index.ts" },
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
        // @autonoma/ai and its transitive deps that esbuild cannot resolve
        // through pnpm's virtual store during bundling
        "@autonoma/ai",
        "@autonoma/errors",
    ],
    platform: "node",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
