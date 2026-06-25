import { join } from "node:path";
import { config } from "dotenv";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
        // `tsc` (the build step) emits compiled *.test.js into dist/. Never run
        // those: they shadow the TS source with a stale copy and flake.
        exclude: [...configDefaults.exclude, "**/dist/**"],
    },
});
