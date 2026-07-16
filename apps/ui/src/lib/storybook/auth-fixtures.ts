const DEFAULT_USER_ID = "user_fixture_01";
const DEFAULT_ORG_ID = "org_fixture_01";
const FIXTURE_EPOCH = "2026-01-01T00:00:00.000Z";
const FIXTURE_EXPIRY = "2036-01-01T00:00:00.000Z";

/** Shape of the better-auth `get-session` response the UI reads. */
export interface SessionFixture {
    user: {
        id: string;
        email: string;
        name: string;
        emailVerified: boolean;
        image?: string;
        role: string;
        createdAt: string;
        updatedAt: string;
    };
    session: {
        id: string;
        userId: string;
        activeOrganizationId?: string;
        expiresAt: string;
        createdAt: string;
        updatedAt: string;
    };
}

/** Shape of a better-auth `organization/list` entry the UI reads. */
export interface OrganizationFixture {
    id: string;
    name: string;
    slug: string;
    logo?: string;
    createdAt: string;
    metadata?: Record<string, string>;
}

interface MakeSessionOverrides {
    userId?: string;
    email?: string;
    name?: string;
    role?: string;
    activeOrganizationId?: string;
}

/** Builds a realistic logged-in session; override only what the story needs. */
export function makeSession(overrides: MakeSessionOverrides = {}): SessionFixture {
    const userId = overrides.userId ?? DEFAULT_USER_ID;
    return {
        user: {
            id: userId,
            email: overrides.email ?? "ada@example.com",
            name: overrides.name ?? "Ada Lovelace",
            emailVerified: true,
            role: overrides.role ?? "user",
            createdAt: FIXTURE_EPOCH,
            updatedAt: FIXTURE_EPOCH,
        },
        session: {
            id: "session_fixture_01",
            userId,
            activeOrganizationId: overrides.activeOrganizationId ?? DEFAULT_ORG_ID,
            expiresAt: FIXTURE_EXPIRY,
            createdAt: FIXTURE_EPOCH,
            updatedAt: FIXTURE_EPOCH,
        },
    };
}

interface MakeOrganizationOverrides {
    id?: string;
    name?: string;
    slug?: string;
}

/** Builds a realistic organization; override only what the story needs. */
export function makeOrganization(overrides: MakeOrganizationOverrides = {}): OrganizationFixture {
    return {
        id: overrides.id ?? DEFAULT_ORG_ID,
        name: overrides.name ?? "Acme Corp",
        slug: overrides.slug ?? "acme-corp",
        createdAt: FIXTURE_EPOCH,
    };
}
