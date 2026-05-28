import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        exclude: ["**/dist/**", "**/node_modules/**"],
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
        testTimeout: 30_000,
    },
});
