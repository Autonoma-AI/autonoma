import { randomUUID } from "node:crypto";

/**
 * One id per process, attached to every event and every log record - lets you
 * group a run's telemetry, count distinct runs, and dedupe. Stable for the life
 * of the CLI invocation.
 *
 * A leaf module on purpose: the logging and debug lanes need it, and `session.ts`
 * imports `debugLog`, so holding it there would close an import cycle.
 */
const RUN_ID = randomUUID();

export function getRunId(): string {
    return RUN_ID;
}
