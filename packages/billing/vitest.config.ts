import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        watch: false,
        // The testcontainer harness supplies the real DB URI at runtime; this
        // placeholder only satisfies the `@autonoma/db` env import. We deliberately
        // do NOT load the repo root .env so real secrets never enter the test env.
        env: {
            DATABASE_URL: "postgresql://placeholder:placeholder@localhost:5432/placeholder",
        },
    },
});
