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
