import { execSync } from "node:child_process";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import type { ModelMessage as AIModelMessage } from "ai";
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
    }
}
