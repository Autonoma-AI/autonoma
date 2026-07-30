import type { PrismaClient } from "@autonoma/db";
import type { ParkedSessionStore } from "../../demo/parked-session.store";
import { env } from "../../env";
import { Service } from "../service";

type OrgStatus = "pending" | "approved" | "rejected";

export interface ActiveOrg {
    id: string;
    name: string;
    slug: string;
    isDemo: boolean;
    canReturnToAccount: boolean;
}

export class AuthService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly parkedSessions: ParkedSessionStore,
    ) {
        super();
    }

    async getActiveOrg(activeOrgId: string, sessionToken: string | undefined): Promise<ActiveOrg | undefined> {
        this.logger.info("Getting active org", { activeOrgId });

        const org = await this.db.organization.findUnique({
            where: { id: activeOrgId },
            select: { id: true, name: true, slug: true },
        });

        if (org == null) return undefined;

        // `isDemo` drives the read-only demo UX (banner + write-block modal); computed
        // server-side so the client never needs the DEMO_ORG id itself.
        const isDemo = env.DEMO_ORG != null && org.id === env.DEMO_ORG;
        // Set only for a visitor who entered the demo from their own signed-in session:
        // the demo cookie replaced theirs, and leaving hands it back.
        const canReturnToAccount = isDemo && (await this.parkedSessions.has(sessionToken));

        return { id: org.id, name: org.name, slug: org.slug, isDemo, canReturnToAccount };
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
