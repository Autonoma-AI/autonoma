import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        env: { ...config({ path: join(__dirname, "../../.env") }).parsed },
        // The workflow bundle is built once for the whole run rather than per suite; see test/global-setup.ts.
        globalSetup: ["./test/global-setup.ts"],
        testTimeout: 60_000,
        // Starting a time-skipping test server downloads a binary on a cold machine, and CI runs these suites on a
        // 4-vCPU runner shared with other packages' tests, so setup needs real headroom.
        hookTimeout: 120_000,
    },
});
