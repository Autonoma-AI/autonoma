import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

const dotenv = config({ path: join(__dirname, "../../.env") }).parsed;

export default defineConfig({
    test: {
        // TEMPORAL_DEBUG lifts the worker's 5s ceiling on any single call into the workflow VM (its deadlock
        // detector, which no `Worker.create` option exposes) and moves workflow execution onto the main thread.
        // Without it, a contended runner can take longer than 5s to initialize the VM for a new execution, and
        // since the server just retries that workflow task against the same starved machine, the execution never
        // gets past its first activation and the test hangs until `testTimeout`. The cost is that a workflow that
        // genuinely deadlocks now fails at `testTimeout` rather than at 5s.
        env: { ...dotenv, TEMPORAL_DEBUG: "1" },
        // Two suites each run their own time-skipping server and a worker holding the 4MB workflow bundle, so
        // running the files concurrently puts two of everything on the same cores.
        fileParallelism: false,
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
