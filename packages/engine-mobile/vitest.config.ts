import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        watch: false,
        testTimeout: 60_000,
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
    },
});
