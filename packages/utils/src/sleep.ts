/**
 * Resolve after `ms` milliseconds. The one shared sleep for the monorepo - import
 * this instead of re-implementing `new Promise((resolve) => setTimeout(resolve, ms))`
 * (which had drifted into ~20 copies under three names: sleep / delay / wait).
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
