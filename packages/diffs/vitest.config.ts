import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        exclude: ["**/dist/**", "**/node_modules/**"],
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
        watch: false,
    },
});
