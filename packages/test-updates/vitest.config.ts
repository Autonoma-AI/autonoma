import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        watch: false,
        globalSetup: ["./test/global-setup.ts"],
        env: {
            // Only here to satisfy the env variable validation
            DATABASE_URL: "postgresql://placeholder:placeholder@localhost:5432/placeholder",
        },
    },
});
