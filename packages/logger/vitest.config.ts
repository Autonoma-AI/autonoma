import { join } from "node:path";
import { config } from "dotenv";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
        // Integration tests (real Loki via Testcontainers) need Docker; keep
        // the default `pnpm test` run fast + Docker-free. Run them with
        // `pnpm test:integration`.
        exclude: [...configDefaults.exclude, "test/integration/**"],
    },
});
