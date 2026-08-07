import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        watch: false,
        globalSetup: ["./test/global-setup.ts"],
        env: {
            DATABASE_URL: "postgresql://placeholder:placeholder@localhost:5432/placeholder",
            ...config({ path: join(__dirname, "../../.env") }).parsed,
        },
    },
});
