export class PlaywrightError extends Error {
    constructor(cause: Error) {
        super(`Playwright operation failed: ${cause.message}`, { cause });
    }
}

export async function runPlaywright<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        throw new PlaywrightError(error as Error);
    }
}
