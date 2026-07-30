import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
        // The workflow bundle is built once for the whole run rather than per suite; see test/global-setup.ts.
        globalSetup: ["./test/global-setup.ts"],
        testTimeout: 60_000,
        // `beforeAll` carries everything slow: a test-server binary download on a cold machine, starting the
        // time-skipping server, and the worker's cold start warm-up (test/fixtures/warm-up-workflow-worker.ts). On a
        // 4-vCPU CI runner shared with every other package's tests those measured ~50s, ~50s and ~90s respectively,
        // so the hook needs headroom well past their sum - a test, by contrast, runs in ~2s once the worker is warm.
        hookTimeout: 300_000,
    },
});
