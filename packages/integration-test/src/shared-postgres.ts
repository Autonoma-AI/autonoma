import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { POSTGRES_IMAGE } from "./postgres-image";
import { stopContainer } from "./stop-container";

const TEMPLATE_DATABASE = "integration_test_template";

// Set by startSharedPostgres() in the package's Vitest globalSetup (main process), read by
// createTestDatabase() in each worker's test file - Vitest inherits globalSetup's process.env
// mutations into every spawned test worker.
const ADMIN_URL_ENV = "AUTONOMA_SHARED_POSTGRES_ADMIN_URL";

export interface StartSharedPostgresOptions {
    /** Applies the schema to the template database once, before any suite forks its own copy. */
    migrate: (connectionUri: string) => void | Promise<void>;
}

export interface SharedPostgres {
    stop: () => Promise<void>;
}

/**
 * Boots a single Postgres container for the whole test run and migrates one template database.
 * Call once from a package's Vitest `globalSetup`; every suite in that run then forks its own
 * isolated database from the template via {@link createTestDatabase} instead of booting its own
 * container and replaying every migration.
 */
export async function startSharedPostgres({ migrate }: StartSharedPostgresOptions): Promise<SharedPostgres> {
    const container = await new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(120_000).start();
    const adminUrl = container.getConnectionUri();

    await withAdminClient(adminUrl, (admin) => admin.query(`CREATE DATABASE "${TEMPLATE_DATABASE}"`));
    await migrate(withDatabase(adminUrl, TEMPLATE_DATABASE));

    process.env[ADMIN_URL_ENV] = adminUrl;

    return {
        stop: async () => {
            delete process.env[ADMIN_URL_ENV];
            await stopContainer(container);
        },
    };
}

/**
 * Creates a fresh, fully-migrated database inside the container {@link startSharedPostgres}
 * started, by cloning the migrated template - near-instant regardless of migration count, since
 * Postgres copies the template's files rather than replaying schema changes. Returns a connection
 * URI scoped to the new database. Call once per suite in place of booting a `PostgreSqlContainer`.
 */
export async function createTestDatabase(): Promise<string> {
    const adminUrl = process.env[ADMIN_URL_ENV];
    if (adminUrl == null) {
        throw new Error(
            "createTestDatabase() called before startSharedPostgres() ran. Call startSharedPostgres() from the package's Vitest globalSetup first.",
        );
    }

    const name = `test_${randomUUID().replaceAll("-", "")}`;
    await withAdminClient(adminUrl, (admin) =>
        admin.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DATABASE}"`),
    );

    return withDatabase(adminUrl, name);
}

async function withAdminClient(adminUrl: string, run: (client: Client) => Promise<unknown>): Promise<void> {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
        await run(client);
    } finally {
        await client.end();
    }
}

function withDatabase(connectionUri: string, database: string): string {
    const url = new URL(connectionUri);
    url.pathname = `/${database}`;
    return url.toString();
}
