import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger as rootLogger } from "@autonoma/logger";
import { bundleWorkflowCode } from "@temporalio/worker";
import type { TestProject } from "vitest/node";

// Compute the workflows bundle entrypoint directly rather than importing `workflowsPath` from ../src/worker: that
// barrel also re-exports the Node-side worker, which transitively imports @autonoma/db (its env.ts validates
// DATABASE_URL at import time). A hermetic workflow test must not require a database - CI runs it without one. The
// Temporal worker bundles this entrypoint in the sandbox, where no db import exists.
const workflowsPath = new URL("../src/workflows/index.ts", import.meta.url).pathname;

/**
 * Bundles the workflows once per run and hands the path to every suite via `workflowBundle()`.
 *
 * Webpack needs ~75s for this bundle on a contended 4-vCPU CI runner, so suites that each built their own copy inside
 * `beforeAll` overran the hook timeout. Building here - in the main process, before any suite starts - both halves the
 * work and moves it out of a timed hook.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
    const logger = rootLogger.child({ name: "workflowTestGlobalSetup" });
    const dir = await mkdtemp(join(tmpdir(), "autonoma-workflow-bundle-"));
    const codePath = join(dir, "workflow-bundle.js");

    logger.info("Bundling workflows for the test run", { extra: { codePath } });
    const bundle = await bundleWorkflowCode({
        workflowsPath,
        // Preserve workflow function names so the client can resolve `investigatorWorkflow` from the bundle by name.
        // Leave `devtool` alone: `Worker.create` rejects a prebuilt bundle with no inlined source map.
        webpackConfigHook: (config) => {
            config.optimization = { ...config.optimization, minimize: false };
            return config;
        },
    });
    await writeFile(codePath, bundle.code, "utf8");
    logger.info("Workflow bundle written", { extra: { codePath, bytes: bundle.code.length } });

    project.provide("workflowBundlePath", codePath);

    return async () => {
        await rm(dir, { recursive: true, force: true }).catch((err) => {
            logger.warn("Failed to clean up the workflow bundle dir", { extra: { dir, err } });
        });
    };
}
