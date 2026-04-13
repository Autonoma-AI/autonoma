export { createTemporalWorker, type CreateWorkerOptions } from "./create-worker";

// Absolute path to the workflows bundle entrypoint.
export const workflowsPath = new URL("../workflows/index.ts", import.meta.url).pathname;
