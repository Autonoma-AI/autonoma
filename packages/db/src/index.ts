import { AsyncLocalStorage } from "node:async_hooks";
import { execSync } from "node:child_process";
import path from "node:path";
import type { ScenarioRecipeSchema, ScenarioStructureJsonSchema } from "@autonoma/types";
import type { EmitterWebhookEvent } from "@octokit/webhooks/types";
import { PrismaPg } from "@prisma/adapter-pg";
import type { ModelMessage as AIModelMessage } from "ai";
import type { z } from "zod";
import { env } from "./env";
import { PrismaClient } from "./generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export function createClient(connectionString: string): PrismaClient {
    const adapter = new PrismaPg({ connectionString });
    return new PrismaClient({ adapter });
}

// Per-scope SQL-statement counter. A client from createQueryCountingClient increments the store of
// the innermost active measureQueries scope on every query event; outside a scope it is a no-op.
const queryCountStore = new AsyncLocalStorage<{ count: number }>();

/**
 * Creates a Prisma client whose query events feed the count scope used by {@link measureQueries}.
 * Query events are delivered to listeners only (not stdout), so this adds no log noise, and the
 * handler is inert outside a measureQueries scope. Intended for tests / instrumentation; production
 * code uses {@link createClient}.
 */
export function createQueryCountingClient(connectionString: string): PrismaClient {
    const adapter = new PrismaPg({ connectionString });
    const client = new PrismaClient({ adapter, log: [{ level: "query", emit: "event" }] });

    client.$on("query", () => {
        const store = queryCountStore.getStore();
        if (store != null) store.count += 1;
    });

    return client;
}

/**
 * Runs `fn` and returns its result alongside the number of SQL statements issued during it by a
 * client built with {@link createQueryCountingClient}. The count is scoped via AsyncLocalStorage, so
 * concurrent calls do not interfere. Used by performance-budget tests to assert a code path stays
 * under a fixed number of database round-trips (e.g. catching N+1 regressions).
 *
 * Note: only the innermost scope is counted - nesting one measureQueries inside another does not roll
 * the inner queries up into the outer total.
 */
export async function measureQueries<T>(fn: () => Promise<T>): Promise<{ result: T; queryCount: number }> {
    const store = { count: 0 };
    const result = await queryCountStore.run(store, fn);
    return { result, queryCount: store.count };
}

function createDefaultClient(): PrismaClient {
    return createClient(env.DATABASE_URL);
}

function getDb(): PrismaClient {
    if (!globalForPrisma.prisma) {
        globalForPrisma.prisma = createDefaultClient();
    }
    return globalForPrisma.prisma;
}

export const db: PrismaClient = new Proxy({} as PrismaClient, {
    get(_, prop: keyof PrismaClient) {
        return getDb()[prop];
    },
});

const PACKAGE_ROOT = path.join(__dirname, "..");

/**
 * Programmatically apply Prisma migrations to the given connection string.
 */
export function applyMigrations(connectionString: string, verbose = false) {
    execSync(`npx prisma migrate deploy --schema ${PACKAGE_ROOT}/prisma/schema.prisma`, {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, DATABASE_URL: connectionString },
        stdio: verbose ? "inherit" : "ignore",
    });
}

export type { PrismaClient } from "./generated/prisma/client";
export * from "./generated/prisma/client";

declare global {
    export namespace PrismaJson {
        export type ModelConversation = AIModelMessage[];
        export type ScenarioRecipeJson = z.infer<typeof ScenarioRecipeSchema>;
        export type ScenarioStructureJson = z.infer<typeof ScenarioStructureJsonSchema>;
        export type ScenarioAuth = {
            cookies?: Array<{
                name: string;
                value: string;
                url?: string;
                domain?: string;
                path?: string;
                expires?: number;
                httpOnly?: boolean;
                secure?: boolean;
                sameSite?: string;
            }>;
            headers?: Record<string, string>;
        };
        export type ScenarioRefs = unknown;
        export type ScenarioMetadata = unknown;
        /**
         * The resolved scenario "create" graph sent to the environment factory at
         * UP - resolved variable values plus the `_alias`/`_ref` structure and any
         * semantic event-tokens. Persisted at UP success as a durable source of
         * truth for the data a test actually ran against. Absent on historical
         * instances created before this field existed; consumers must degrade
         * gracefully when it is null.
         */
        export type ScenarioGeneratedData = unknown;
        export type ScenarioLastError = { message: string };
        export type AgentLogEntry = Array<{ id: string; message: string; timestamp: string }>;
        export type GitHubWebhookPayload = EmitterWebhookEvent["payload"];
        export type PreviewkitManifest = {
            apps?: Array<{ name: string; port?: number | null; primary?: boolean | null }>;
            services?: Array<{ name: string; recipe?: string | null; version?: string | null }>;
            addons?: Array<{ name: string; provider?: string | null }>;
        };

        // Provider-controlled opaque blob persisted alongside the addon row.
        // Whatever provision() returned in `state` is exactly what deprovision()
        // sees — providers are responsible for shape compatibility across
        // versions of their own code.
        export type PreviewkitAddonState = Record<string, unknown>;
        // Public outputs surfaced into the template engine; apps reference
        // them as {{addonName.<key>}} in env and build_args.
        export type PreviewkitAddonOutputs = Record<string, string>;
    }
}
