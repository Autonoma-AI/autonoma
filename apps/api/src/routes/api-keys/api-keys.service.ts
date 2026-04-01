import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { hashApiKey } from "../../application-setup/verify-api-key";
import { Service } from "../service";

export class ApiKeysService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async list(organizationId: string) {
        const members = await this.db.member.findMany({
            where: { organizationId },
            select: { userId: true },
        });
        const userIds = members.map((m) => m.userId);

        const keys = await this.db.apiKey.findMany({
            where: { userId: { in: userIds } },
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

    async create(userId: string, name: string) {
        const rawKey = `ask_${randomBytes(32).toString("hex")}`;
        const hashedKey = hashApiKey(rawKey);

        const created = await this.db.apiKey.create({
            data: { name, userId, key: hashedKey, start: rawKey.slice(0, 7), enabled: true },
            select: { id: true },
        });

        this.logger.info("Created API key", { userId, name, keyId: created.id });
        return { id: created.id, key: rawKey };
    }

    async delete(keyId: string, organizationId: string) {
        const key = await this.db.apiKey.findUnique({
            where: { id: keyId },
            select: { userId: true },
        });
        if (key == null) {
            throw new NotFoundError("API key not found");
        }

        const member = await this.db.member.findFirst({
            where: { userId: key.userId, organizationId },
        });
        if (member == null) {
            throw new NotFoundError("API key not found");
        }

        await this.db.apiKey.delete({ where: { id: keyId } });
        this.logger.info("Deleted API key", { keyId, organizationId });
    }
}
