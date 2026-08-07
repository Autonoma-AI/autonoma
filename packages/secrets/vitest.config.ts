import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        watch: false,
        globalSetup: ["./test/global-setup.ts"],
        // The harnesses supply the real Postgres URI and KMS endpoint at runtime;
        // this placeholder only satisfies the `@autonoma/db` env import. We
        // deliberately do NOT load the repo root .env - a package whose whole job
        // is key handling is the last one that should pull real secrets into its
        // test environment, and CI has no .env to load anyway.
        env: {
            DATABASE_URL: "postgresql://placeholder:placeholder@localhost:5432/placeholder",
        },
        // Both suites are container-backed (Postgres, and MiniStack for KMS), so
        // give them the same headroom as the other integration packages: image
        // pulls and container boot routinely exceed Vitest's defaults under CI
        // contention.
        testTimeout: 120_000,
        hookTimeout: 180_000,
    },
});
