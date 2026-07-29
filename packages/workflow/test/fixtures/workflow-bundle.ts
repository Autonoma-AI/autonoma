import { inject } from "vitest";

declare module "vitest" {
    interface ProvidedContext {
        /** Path to the workflow bundle built once per run by {@link ../global-setup}. */
        workflowBundlePath: string;
    }
}

/**
 * The prebuilt workflow bundle, to pass as `Worker.create({ workflowBundle })`.
 *
 * Workers that host workflows must use this instead of `workflowsPath` so they reuse the one bundle the global setup
 * built - bundling per suite takes ~75s each on a contended CI runner and overran the `beforeAll` timeout. Workers
 * that only host activities need no bundle at all.
 */
export function workflowBundle(): { codePath: string } {
    return { codePath: inject("workflowBundlePath") };
}
