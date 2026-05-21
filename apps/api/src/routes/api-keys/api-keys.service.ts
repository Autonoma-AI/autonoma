import { randomBytes } from "node:crypto";
import { hashApiKey } from "@autonoma/auth";
import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { Service } from "../service";

export class ApiKeysService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async list(organizationId: string) {
        const keys = await this.db.apiKey.findMany({
            where: { organizationId },
            select: {
                id: true,
                name: true,
                start: true,
                createdAt: true,
                lastRequest: true,
                user: { select: { id: true, name: true, email: true } },
            },
            orderBy: { createdAt: "desc" },
        });

        this.logger.info("Listed API keys", { organizationId, count: keys.length });
        return keys;
    }

    async create(userId: string, organizationId: string, name: string) {
        const rawKey = `ask_${randomBytes(32).toString("hex")}`;
        const hashedKey = hashApiKey(rawKey);

        const created = await this.db.apiKey.create({
            data: { name, userId, organizationId, key: hashedKey, start: rawKey.slice(0, 7), enabled: true },
            select: { id: true },
        });

        this.logger.info("Created API key", { userId, organizationId, name, keyId: created.id });
        return { id: created.id, key: rawKey };
    }

    async delete(keyId: string, organizationId: string) {
        const key = await this.db.apiKey.findUnique({
            where: { id: keyId },
            select: { organizationId: true },
        });
        if (key == null || key.organizationId !== organizationId) {
            throw new NotFoundError("API key not found");
        }

        await this.db.apiKey.delete({ where: { id: keyId } });
        this.logger.info("Deleted API key", { keyId, organizationId });
    }
}
