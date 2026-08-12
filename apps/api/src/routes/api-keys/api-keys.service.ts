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
        const [keys, members] = await Promise.all([
            this.db.apiKey.findMany({
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
            }),
            this.db.member.findMany({ where: { organizationId }, select: { userId: true } }),
        ]);

        const memberIds = new Set(members.map((member) => member.userId));
        // A key outlives the membership of whoever minted it: removing a member deletes only the
        // keys the remover picked, so the rest keep working and would otherwise be indistinguishable
        // from a colleague's. Flagging them is what stops a credential held by someone outside the
        // organization sitting here unnoticed - the remove dialog is a moment, this screen is not.
        const withOwnership = keys.map((key) => ({
            ...key,
            ownerLeft: key.user != null && !memberIds.has(key.user.id),
        }));

        this.logger.info("Listed API keys", {
            organizationId,
            extra: {
                count: keys.length,
                orphanedCount: withOwnership.filter((key) => key.ownerLeft).length,
            },
        });
        return withOwnership;
    }

    /**
     * The keys one member holds in this organization, for the confirm dialog that removes them.
     * `lastRequest` is the field that decides the answer - a key used an hour ago is load-bearing
     * for something, a key never used is not - so it is selected even though the row is otherwise
     * identified by name.
     */
    async listForMember(organizationId: string, userId: string) {
        const keys = await this.db.apiKey.findMany({
            where: { organizationId, userId },
            select: { id: true, name: true, start: true, createdAt: true, lastRequest: true },
            orderBy: { createdAt: "desc" },
        });

        this.logger.info("Listed a member's API keys", {
            organizationId,
            extra: { targetUserId: userId, count: keys.length },
        });
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
