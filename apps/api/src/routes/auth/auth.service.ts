import type { PrismaClient } from "@autonoma/db";
import { env } from "../../env";
import { Service } from "../service";

type OrgStatus = "pending" | "approved" | "rejected";

export class AuthService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async getActiveOrg(
        activeOrgId: string,
    ): Promise<{ id: string; name: string; slug: string; isDemo: boolean } | undefined> {
        this.logger.info("Getting active org", { activeOrgId });

        const org = await this.db.organization.findUnique({
            where: { id: activeOrgId },
            select: { id: true, name: true, slug: true },
        });

        if (org == null) return undefined;

        // `isDemo` drives the read-only demo UX (banner + write-block modal); computed
        // server-side so the client never needs the DEMO_ORG id itself.
        return { ...org, isDemo: env.DEMO_ORG != null && org.id === env.DEMO_ORG };
    }

    async getOrgStatus(userId: string): Promise<OrgStatus | undefined> {
        this.logger.info("Getting org status", { userId });

        const membership = await this.db.member.findFirst({
            where: { userId },
            select: { organization: { select: { status: true } } },
        });

        if (membership == null) return "pending";

        return membership.organization.status;
    }
}
