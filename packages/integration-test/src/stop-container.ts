import { logger as rootLogger } from "@autonoma/logger";
import type { StartedTestContainer } from "testcontainers";

// A concurrent Ryuk reap (Testcontainers' session-cleanup sidecar) or the Docker daemon still
// reporting "running" mid-stop can make `docker rm` fail even though the container is already
// gone or going - not a real teardown failure, so we tolerate it below.
const BENIGN_TEARDOWN_ERROR_PATTERNS = [/cannot remove container/i, /no such container/i];

function isBenignTeardownRace(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return BENIGN_TEARDOWN_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/** Stops a Testcontainers container, tolerating the benign removal race described above. */
export async function stopContainer(container: StartedTestContainer): Promise<void> {
    const logger = rootLogger.child({ name: "stopContainer" });
    try {
        await container.stop();
    } catch (err) {
        if (!isBenignTeardownRace(err)) throw err;
        logger.warn("Container teardown hit a benign removal race; treating as already stopped", { err });
    }
}
