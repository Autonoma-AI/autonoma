let scenarioEncryptionKey: string | undefined;

export function validateWorkerEnv(): void {
    const key = process.env["SCENARIO_ENCRYPTION_KEY"];

    if (key == null || key === "") {
        throw new Error("SCENARIO_ENCRYPTION_KEY is required for scenario activities");
    }

    scenarioEncryptionKey = key;
}

export function getScenarioEncryptionKey(): string {
    if (scenarioEncryptionKey == null) {
        throw new Error("Worker env not initialized. Call validateWorkerEnv() at startup.");
    }

    return scenarioEncryptionKey;
}
