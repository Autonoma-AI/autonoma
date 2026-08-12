import { startSharedPostgres } from "@autonoma/integration-test";

let stop: (() => Promise<void>) | undefined;

/** One Postgres container for the whole suite; each harness forks its own database from the migrated template. */
export async function setup(): Promise<void> {
    // Set TESTING before any @autonoma/* imports so createEnv skips validation.
    process.env.TESTING = "true";
    const { applyMigrations } = await import("@autonoma/db");
    const shared = await startSharedPostgres({ migrate: applyMigrations });
    stop = shared.stop;
}

export async function teardown(): Promise<void> {
    await stop?.();
}
