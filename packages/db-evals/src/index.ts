import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "./env";
import { PrismaClient } from "./generated/prisma/client";

export { PrismaClient } from "./generated/prisma/client";
export * from "./generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prismaEvals: PrismaClient };

export function createEvalsClient(connectionString: string): PrismaClient {
    const adapter = new PrismaPg({ connectionString });
    return new PrismaClient({ adapter });
}

function getDb(): PrismaClient {
    if (!globalForPrisma.prismaEvals) {
        const adapter = new PrismaPg({ connectionString: env.DATABASE_EVALS_URL });
        globalForPrisma.prismaEvals = new PrismaClient({ adapter });
    }
    return globalForPrisma.prismaEvals;
}

export const dbEvals: PrismaClient = new Proxy({} as PrismaClient, {
    get(_, prop: keyof PrismaClient) {
        return getDb()[prop];
    },
});
