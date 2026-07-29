import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        include: ["test/integration/**/*.test.ts"],
        // One real kind cluster is created per file; never run them in parallel.
        fileParallelism: false,
        // Cluster creation + image pulls + reaching terminal pod states.
        testTimeout: 240_000,
        hookTimeout: 300_000,
        env: {
            TESTING: "true",
        },
    },
});
