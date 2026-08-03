import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { env } from "../env";

/**
 * Who an MCP tool call acts as, and the complete set of organizations it may act in.
 *
 * `organizationIds` is the authorization boundary for the whole MCP surface, resolved once
 * per request by {@link resolveMcpPrincipal}. It is a required field rather than an optional
 * narrowing passed alongside a user id, because the two credentials the surface accepts grant
 * different breadth: an OAuth token spans every org its user belongs to, an API key is minted
 * for exactly one. An optional narrowing would default to the wider of those, so any call site
 * that forgot it would silently widen an API key to all of its owner's orgs. Requiring the
 * resolved set makes that a compile error instead.
 */
export interface McpPrincipal {
    /** The authenticated user, for rate-limit keys and logging - never for authorization. */
    userId: string;
    /** Every organization this credential may act in. Empty means the caller can reach nothing. */
    organizationIds: string[];
}

/** The verified credential, before it has been turned into an authorization boundary. */
export interface McpCredential {
    userId: string;
    /** Set only for an API key, which is minted for a single organization. */
    organizationId?: string;
}

/**
 * Resolve the organizations an authenticated MCP caller may act in: the orgs the user is a
 * member of, narrowed to the one an API key was minted for, minus the read-only demo org.
 *
 * The demo org is excluded here rather than at each call site because the MCP path bypasses
 * `writeProcedure`: a demo viewer is a member of `DEMO_ORG` (so `orgStatus` resolves to
 * "approved") and could otherwise read secrets and logs and mutate config through the tools.
 *
 * A scope narrows memberships, it never replaces them - an API key naming an org its owner
 * does not belong to resolves to nothing, exactly like any other unreachable org.
 */
export async function resolveMcpPrincipal(db: PrismaClient, credential: McpCredential): Promise<McpPrincipal> {
    const logger = rootLogger.child({ name: "resolveMcpPrincipal" });

    const memberships = await db.member.findMany({
        where: {
            userId: credential.userId,
            // undefined leaves this unfiltered, which is the OAuth (multi-org) case.
            organizationId: credential.organizationId,
        },
        select: { organizationId: true },
    });

    const organizationIds = memberships
        .map((membership) => membership.organizationId)
        .filter((organizationId) => organizationId !== env.DEMO_ORG);

    logger.info("Resolved MCP principal", {
        userId: credential.userId,
        extra: { organizationCount: organizationIds.length, scoped: credential.organizationId != null },
    });
    return { userId: credential.userId, organizationIds };
}
