import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        watch: false,
        env: {
            // Only here to satisfy the env variable validation
            DATABASE_URL: "postgresql://placeholder:placeholder@localhost:5432/placeholder",
        },
        // These are Testcontainers-backed integration tests: each case seeds real rows
        // (org + app + snapshot + assignments + runs) against Postgres, which routinely
        // exceeds Vitest's 5s default under CI contention. Give them the same headroom as
        // the other integration packages (see packages/investigation/vitest.config.ts).
        testTimeout: 120_000,
        hookTimeout: 180_000,
    },
});
