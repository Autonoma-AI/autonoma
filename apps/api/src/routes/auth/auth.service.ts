import type { PrismaClient } from "@autonoma/db";
import { orgHasAutoJoinDomain } from "@autonoma/types";
import type { DemoEntrySourceStore } from "../../demo/demo-entry-source.store";
import type { ParkedSessionStore } from "../../demo/parked-session.store";
import { env } from "../../env";
import { Service } from "../service";

type OrgStatus = "pending" | "approved" | "rejected";

const VERCEL_MARKETPLACE_ENTRY_SOURCE = "vercel-marketplace";

export interface ActiveOrg {
    id: string;
    name: string;
    slug: string;
    isDemo: boolean;
    canReturnToAccount: boolean;
    /**
     * Whether the merge gate is effectively enabled for this org: the global `MERGE_GATE_ENABLED` switch AND the
     * org's own `mergeGateEnabled`. Gates activation-only UI (the analysis-triggers settings page, the PR
     * "Run analysis" button) so clients not in the merge-gate program never see it.
     */
    mergeGateEnabled: boolean;
    vercelMarketplaceEntry: boolean;
    /**
     * Whether this organization still carries the name it was auto-given, and should be asked for a
     * real one. True only for an org created from a personal email address - it was named after
     * whoever signed up first, who is not necessarily whose organization it is - and only until
     * somebody confirms a name. An org named from a real email domain is already the company's name.
     */
    needsNaming: boolean;
}

export class AuthService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly parkedSessions: ParkedSessionStore,
        private readonly demoEntrySources: DemoEntrySourceStore,
    ) {
        super();
    }

    async getActiveOrg(activeOrgId: string, sessionToken: string | undefined): Promise<ActiveOrg | undefined> {
        this.logger.info("Getting active org", { activeOrgId });

        const org = await this.db.organization.findUnique({
            where: { id: activeOrgId },
            select: {
                id: true,
                name: true,
                slug: true,
                domain: true,
                nameConfirmedAt: true,
                settings: { select: { mergeGateEnabled: true } },
            },
        });

        if (org == null) return undefined;

        // `isDemo` drives the read-only demo UX (banner + write-block modal); computed
        // server-side so the client never needs the DEMO_ORG id itself.
        const isDemo = env.DEMO_ORG != null && org.id === env.DEMO_ORG;
        // Two independent Redis lookups, only worth making for a demo org - run together.
        // - canReturnToAccount: set only for a visitor who entered the demo from their own
        //   signed-in session; the demo cookie replaced theirs, and leaving hands it back.
        // - vercelMarketplaceEntry: set for a visitor who entered via Vercel's marketplace
        //   listing, so the banner can send them back there instead of a direct sign-up CTA.
        const [canReturnToAccount, entrySource] = isDemo
            ? await Promise.all([this.parkedSessions.has(sessionToken), this.demoEntrySources.get(sessionToken)])
            : [false, undefined];
        const vercelMarketplaceEntry = entrySource === VERCEL_MARKETPLACE_ENTRY_SOURCE;

        // Effective merge-gate state (global switch AND the org's opt-in)
        const mergeGateEnabled = env.MERGE_GATE_ENABLED && org.settings?.mergeGateEnabled === true;
        // Naming is only asked of an org whose name was auto-derived from one person's email
        // address; an org named after a real email domain already carries the company's name.
        const needsNaming = !isDemo && !orgHasAutoJoinDomain(org.domain ?? undefined) && org.nameConfirmedAt == null;

        return {
            id: org.id,
            name: org.name,
            slug: org.slug,
            isDemo,
            canReturnToAccount,
            mergeGateEnabled,
            vercelMarketplaceEntry,
            needsNaming,
        };
    }

    /**
     * The approval status of the organization this session is acting as - the one whose pages are
     * about to render - not "some organization this user belongs to".
     *
     * The difference matters now that an account can hold several memberships (invitations, the
     * admin org switcher, Vercel installs). This read used to be an unordered `member.findFirst`,
     * so a user who was approved in one organization and pending in another got sent to `/pending`
     * or not depending on which row Postgres happened to return.
     *
     * Falls back to the oldest membership when the session names no organization, matching how
     * `ensureOrgMembership` resolves a default.
     */
    async getOrgStatus(userId: string, activeOrganizationId?: string): Promise<OrgStatus | undefined> {
        this.logger.info("Getting org status", { userId, organizationId: activeOrganizationId });

        const membership =
            activeOrganizationId != null
                ? await this.db.member.findUnique({
                      where: { userId_organizationId: { userId, organizationId: activeOrganizationId } },
                      select: { organization: { select: { status: true } } },
                  })
                : await this.db.member.findFirst({
                      where: { userId },
                      select: { organization: { select: { status: true } } },
                      orderBy: { createdAt: "asc" },
                  });

        if (membership == null) return "pending";

        return membership.organization.status;
    }
}
