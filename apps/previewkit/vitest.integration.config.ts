import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/integration/**/*.test.ts"],
        fileParallelism: false,
        globalSetup: ["./test/integration/global-setup.ts"],
        testTimeout: 30_000,
        env: {
            TESTING: "true",
        },
    },
});
