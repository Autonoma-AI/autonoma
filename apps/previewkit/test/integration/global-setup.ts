import { PostgreSqlContainer } from "@testcontainers/postgresql";

const POSTGRES_IMAGE = "postgres:17-alpine";

let teardownFns: Array<() => Promise<void>> = [];

export async function setup(): Promise<void> {
    process.env.TESTING = "true";

    const useCI = process.env.CI_DATABASE_URL != null;
    if (useCI) {
        const pgUrl = process.env.CI_DATABASE_URL!;
        const { applyMigrations } = await import("@autonoma/db");
        applyMigrations(pgUrl);
        process.env.TEST_DATABASE_URL = pgUrl;
        process.env.DATABASE_URL = pgUrl;
        return;
    }

    const pgContainer = await new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(120_000).start();
    const pgUrl = pgContainer.getConnectionUri();

    const { applyMigrations } = await import("@autonoma/db");
    applyMigrations(pgUrl);

    process.env.TEST_DATABASE_URL = pgUrl;
    process.env.DATABASE_URL = pgUrl;

    teardownFns = [
        async () => {
            await pgContainer.stop();
        },
    ];
}

export async function teardown(): Promise<void> {
    await Promise.allSettled(teardownFns.map((fn) => fn()));
}
