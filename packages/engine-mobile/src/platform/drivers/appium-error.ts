export class AppiumError extends Error {
    constructor(public readonly error: Error) {
        super(`Appium operation failed: ${error.message}`);
    }
}

export async function runAppium<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        throw new AppiumError(error instanceof Error ? error : new Error(String(error)));
    }
}
