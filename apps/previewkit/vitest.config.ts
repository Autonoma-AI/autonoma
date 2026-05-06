import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        include: ["test/**/*.test.ts"],
        exclude: ["test/integration/**", "node_modules/**"],
    },
});
