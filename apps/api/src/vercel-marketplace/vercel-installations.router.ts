import { randomBytes } from "node:crypto";
import { hashApiKey } from "@autonoma/auth";
import { syncVercelPlanPricing } from "@autonoma/billing";
import { db, VercelBillingPeriodStatus, VercelInstallationStatus } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { toSlug } from "@autonoma/utils";
import { Hono } from "hono";
import { z } from "zod";
import { getVercelEncryptionHelper } from "../context";
import { authenticateVercelRequest } from "./vercel-auth";
import { createBillingPeriod } from "./vercel-billing";
import { resolveUniqueOrgSlug } from "./vercel-helpers";

const logger = rootLogger.child({ name: "VercelInstallationsRouter" });

// ─── Types ─────────────────────────────────────────────────────────────────

interface ProvisionedResourceSecrets {
    clientId: string;
    secretId: string;
}

// ─── Request body schemas ─────────────────────────────────────────────────────

const PutInstallationBodySchema = z.object({
    account: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
    credentials: z.object({ access_token: z.string().optional() }).optional(),
});

const PatchInstallationBodySchema = z.object({
    billingPlanId: z.string().optional(),
});

const PostResourceBodySchema = z.object({
    productId: z.string().optional(),
    name: z.string().optional(),
    billingPlanId: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
});

const PatchResourceBodySchema = z.object({
    name: z.string().optional(),
    billingPlanId: z.string().optional(),
});

/**
 * Resolves the organization to attach this installation to. Vercel issues a
 * fresh `installationId` on every reinstall of the same account (e.g. an
 * uninstall/reinstall or a marketplace-initiated reconnect), so matching by
 * `installationId` alone would spin up a brand-new organization every time -
 * matching by the stable `vercelAccountId` first lets a reconnect reuse the
 * account's existing organization instead.
 */
async function resolveOrganizationForInstallation(
    installationId: string,
    accountId: string,
    accountName: string,
): Promise<string> {
    const existingByInstallation = await db.vercelInstallation.findUnique({
        where: { vercelInstallationId: installationId },
        select: { organizationId: true },
    });
    if (existingByInstallation != null) return existingByInstallation.organizationId;

    const existingByAccount = await db.vercelInstallation.findFirst({
        where: { vercelAccountId: accountId },
        orderBy: { createdAt: "desc" },
        select: { organizationId: true },
    });
    if (existingByAccount != null) {
        logger.info("Reusing existing org for reconnected Vercel account", {
            installationId,
            accountId,
            organizationId: existingByAccount.organizationId,
        });
        return existingByAccount.organizationId;
    }

    logger.info("Creating new org for Vercel installation", { installationId, accountId });

    const slug = await resolveUniqueOrgSlug(toSlug(accountName));
    const org = await db.organization.create({
        data: { name: accountName, slug, status: "approved" },
    });

    return org.id;
}

async function resolveUserForEmail(email: string, name?: string): Promise<string> {
    const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (existing != null) return existing.id;

    const user = await db.user.create({
        data: { name: name ?? email, email, emailVerified: true, role: "user" },
        select: { id: true },
    });
    return user.id;
}

/** Find-then-create-if-missing (never an upsert-with-empty-update). Returns the member id. */
async function ensureMemberExistsOrCreate(userId: string, organizationId: string): Promise<string> {
    const existing = await db.member.findUnique({
        where: { userId_organizationId: { userId, organizationId } },
        select: { id: true },
    });
    if (existing != null) return existing.id;

    const created = await db.member.create({
        data: { userId, organizationId, role: "owner" },
        select: { id: true },
    });

    return created.id;
}

async function getDefaultPlan() {
    return db.vercelBillingPlan.findFirst({ where: { isDefault: true } });
}

/**
 * Creates an API key for the org's first member, to hand back to Vercel as
 * resource secrets. Returns the secrets on success, or `undefined` when no
 * member exists to own the key - callers log and fall back accordingly.
 */
async function createResourceSecrets(organizationId: string): Promise<ProvisionedResourceSecrets | undefined> {
    const member = await db.member.findFirst({
        where: { organizationId },
        select: { userId: true },
    });

    if (member == null) {
        logger.warn("No member found for organization, skipping API key creation", { organizationId });
        return undefined;
    }

    const rawKey = `ask_${randomBytes(32).toString("hex")}`;
    const hashedKey = hashApiKey(rawKey);
    const apiKey = await db.apiKey.create({
        data: {
            name: "Vercel Integration",
            userId: member.userId,
            organizationId,
            key: hashedKey,
            start: rawKey.slice(0, 7),
            enabled: true,
        },
        select: { id: true },
    });

    logger.info("API key created for Vercel resource", { organizationId });
    return { clientId: apiKey.id, secretId: rawKey };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const vercelInstallationsRouter = new Hono();

/**
 * Every installation-scoped route below trusts the `:installationId` path
 * param to look up data - without this check, a valid Vercel JWT issued for
 * one installation could read/mutate a *different* installation simply by
 * changing the URL, since a verified JWT alone says nothing about which
 * installation it authorizes. System Auth tokens with no installation
 * context (`installationId == null`) are never valid on these routes - every
 * handler below acts on exactly one specific installation.
 */
function installationMismatch(auth: { installationId: string | undefined }, installationId: string): boolean {
    return auth.installationId == null || auth.installationId !== installationId;
}

// PUT /:installationId - Upsert installation (called by Vercel when integration installed/updated)
vercelInstallationsRouter.put("/:installationId", async (c) => {
    const { installationId } = c.req.param();
    logger.info("PUT installation", { installationId });

    const auth = await authenticateVercelRequest(c);
    if (!auth.success) {
        logger.warn("Unauthenticated PUT installation request", { installationId, error: auth.error });
        return c.json({ error: auth.error }, 401);
    }
    if (auth.userId == null) {
        logger.warn("PUT installation request missing user context", { installationId, authType: auth.authType });
        return c.json({ error: "Expected a user-authenticated request" }, 400);
    }
    if (installationMismatch(auth, installationId)) {
        logger.warn("PUT installation: JWT installationId does not match path", {
            installationId,
            authInstallationId: auth.installationId,
        });
        return c.json({ error: "Installation mismatch" }, 403);
    }
    const vercelUserId = auth.userId;

    const body = PutInstallationBodySchema.parse(
        await c.req.json<unknown>().catch((error) => {
            logger.warn("Could not parse request body, using defaults", { error });
            return {};
        }),
    );

    const accountId = body.account?.id ?? auth.accountId;
    const accountName = body.account?.name ?? accountId;
    const accessToken = body.credentials?.access_token;

    logger.info("Upserting installation", { installationId, accountId, accountName });

    const organizationId = await resolveOrganizationForInstallation(installationId, accountId, accountName);

    const userId =
        auth.userEmail != null
            ? await resolveUserForEmail(auth.userEmail, auth.userName)
            : await resolveUserForEmail(`vercel-${vercelUserId}@vercel-marketplace.internal`, accountName);

    const defaultPlan = await getDefaultPlan();
    const accessTokenEnc = accessToken != null ? getVercelEncryptionHelper().encrypt(accessToken) : undefined;

    await db.$transaction(async (tx) => {
        await ensureMemberExistsOrCreate(userId, organizationId);

        // Supersede older installation rows for the same Vercel account: a
        // reconnect arrives with a new installationId, so the upsert below
        // creates a new row rather than updating the old one - without this,
        // the old row lingers as "active" with a now-dead access token.
        const supersededCount = await tx.vercelInstallation.updateMany({
            where: {
                vercelAccountId: accountId,
                vercelInstallationId: { not: installationId },
                status: VercelInstallationStatus.active,
            },
            data: { status: VercelInstallationStatus.deleted },
        });
        if (supersededCount.count > 0) {
            logger.info("Superseded stale Vercel installations for reconnected account", {
                installationId,
                accountId,
                supersededCount: supersededCount.count,
            });
        }

        await tx.vercelInstallation.upsert({
            where: { vercelInstallationId: installationId },
            update: {
                vercelAccountId: accountId,
                vercelUserId,
                userId,
                organizationId,
                status: VercelInstallationStatus.active,
                accessTokenEnc,
            },
            create: {
                vercelInstallationId: installationId,
                vercelAccountId: accountId,
                vercelUserId,
                userId,
                organizationId,
                status: VercelInstallationStatus.active,
                accessTokenEnc,
                billingPlanId: defaultPlan?.id,
            },
        });
    });

    logger.info("Installation upserted", { installationId, organizationId });

    return c.json({
        billingPlan:
            defaultPlan != null
                ? {
                      id: defaultPlan.id,
                      name: defaultPlan.name,
                      type: defaultPlan.type,
                      scope: defaultPlan.scope,
                      description: defaultPlan.description,
                  }
                : null,
    });
});

// PATCH /:installationId - Update billing plan
vercelInstallationsRouter.patch("/:installationId", async (c) => {
    const { installationId } = c.req.param();
    logger.info("PATCH installation", { installationId });

    const auth = await authenticateVercelRequest(c);
    if (!auth.success) {
        return c.json({ error: auth.error }, 401);
    }
    if (installationMismatch(auth, installationId)) {
        logger.warn("PATCH installation: JWT installationId does not match path", {
            installationId,
            authInstallationId: auth.installationId,
        });
        return c.json({ error: "Installation mismatch" }, 403);
    }

    const body = PatchInstallationBodySchema.parse(
        await c.req.json<unknown>().catch((error) => {
            logger.warn("Could not parse request body, using defaults", { error });
            return {};
        }),
    );

    const installation = await db.vercelInstallation.findUnique({
        where: { vercelInstallationId: installationId },
    });

    if (installation == null) {
        return c.json({ error: "Installation not found" }, 404);
    }

    if (body.billingPlanId != null) {
        const plan = await db.vercelBillingPlan.findUnique({ where: { id: body.billingPlanId } });
        if (plan == null) {
            return c.json({ error: "Billing plan not found" }, 404);
        }

        await db.vercelInstallation.update({
            where: { id: installation.id },
            data: { billingPlanId: body.billingPlanId },
        });

        logger.info("Installation billing plan updated", { installationId, planId: body.billingPlanId });

        return c.json({
            billingPlan: {
                id: plan.id,
                name: plan.name,
                type: plan.type,
                scope: plan.scope,
                description: plan.description,
            },
        });
    }

    return c.json({ ok: true });
});

// DELETE /:installationId - Delete installation
vercelInstallationsRouter.delete("/:installationId", async (c) => {
    const { installationId } = c.req.param();
    logger.info("DELETE installation", { installationId });

    const auth = await authenticateVercelRequest(c);
    if (!auth.success) {
        return c.json({ error: auth.error }, 401);
    }
    if (installationMismatch(auth, installationId)) {
        logger.warn("DELETE installation: JWT installationId does not match path", {
            installationId,
            authInstallationId: auth.installationId,
        });
        return c.json({ error: "Installation mismatch" }, 403);
    }

    const installation = await db.vercelInstallation.findUnique({
        where: { vercelInstallationId: installationId },
    });

    if (installation == null) {
        logger.warn("DELETE installation not found", { installationId });
        return c.json({ ok: true });
    }

    await db.$transaction(async (tx) => {
        // Cancel billing periods for installation
        await tx.vercelBillingPeriod.updateMany({
            where: { installationId: installation.id, status: "active" },
            data: { status: VercelBillingPeriodStatus.cancelled },
        });

        // Cancel billing periods for all resources under this installation
        const resources = await tx.vercelResource.findMany({
            where: { vercelInstallationId: installation.id },
            select: { id: true },
        });

        for (const resource of resources) {
            await tx.vercelBillingPeriod.updateMany({
                where: { resourceId: resource.id, status: "active" },
                data: { status: VercelBillingPeriodStatus.cancelled },
            });
        }

        // Delete all resources (must happen before installation due to FK)
        await tx.vercelResource.deleteMany({
            where: { vercelInstallationId: installation.id },
        });

        // Soft-delete the installation rather than removing the row - keeps
        // the vercelAccountId -> organizationId link alive so a future
        // reinstall of the same account (which always arrives with a new
        // installationId) can find and reuse this organization instead of
        // creating a duplicate. The access token is revoked by Vercel on
        // uninstall regardless, so it's cleared here too.
        await tx.vercelInstallation.update({
            where: { id: installation.id },
            data: { status: VercelInstallationStatus.deleted, accessTokenEnc: null },
        });
    });

    logger.info("Installation deleted", { installationId, organizationId: installation.organizationId });

    return c.json({ finalized: true });
});

// GET /:installationId - Get installation billing info
vercelInstallationsRouter.get("/:installationId", async (c) => {
    const { installationId } = c.req.param();
    logger.info("GET installation", { installationId });

    const auth = await authenticateVercelRequest(c);
    if (!auth.success) {
        return c.json({ error: auth.error }, 401);
    }
    if (installationMismatch(auth, installationId)) {
        logger.warn("GET installation: JWT installationId does not match path", {
            installationId,
            authInstallationId: auth.installationId,
        });
        return c.json({ error: "Installation mismatch" }, 403);
    }

    const installation = await db.vercelInstallation.findUnique({
        where: { vercelInstallationId: installationId },
        include: { billingPlan: true },
    });

    if (installation == null) {
        return c.json({ error: "Installation not found" }, 404);
    }

    return c.json({
        id: installation.vercelInstallationId,
        status: installation.status,
        billingPlan:
            installation.billingPlan != null
                ? {
                      id: installation.billingPlan.id,
                      name: installation.billingPlan.name,
                      type: installation.billingPlan.type,
                      scope: installation.billingPlan.scope,
                      description: installation.billingPlan.description,
                  }
                : null,
    });
});

// GET /:installationId/plans - List available billing plans
vercelInstallationsRouter.get("/:installationId/plans", async (c) => {
    const { installationId } = c.req.param();
    logger.info("GET installation plans", { installationId });

    const auth = await authenticateVercelRequest(c);
    if (!auth.success) {
        return c.json({ error: auth.error }, 401);
    }
    if (installationMismatch(auth, installationId)) {
        logger.warn("GET installation plans: JWT installationId does not match path", {
            installationId,
            authInstallationId: auth.installationId,
        });
        return c.json({ error: "Installation mismatch" }, 403);
    }

    const plans = await db.vercelBillingPlan.findMany({
        where: { type: "subscription" },
        orderBy: [{ level: "asc" }, { name: "asc" }],
    });

    return c.json({
        plans: plans.map((plan) => ({
            id: plan.id,
            name: plan.name,
            type: plan.type,
            scope: plan.scope,
            description: plan.description,
            cost: plan.cost,
            paymentMethodRequired: plan.paymentMethodRequired,
        })),
    });
});

// POST /:installationId/billing/provision - Billing provision
vercelInstallationsRouter.post("/:installationId/billing/provision", async (c) => {
    const { installationId } = c.req.param();
    logger.info("POST billing provision", { installationId });

    const auth = await authenticateVercelRequest(c);
    if (!auth.success) {
        return c.json({ error: auth.error }, 401);
    }
    if (installationMismatch(auth, installationId)) {
        logger.warn("POST billing provision: JWT installationId does not match path", {
            installationId,
            authInstallationId: auth.installationId,
        });
        return c.json({ error: "Installation mismatch" }, 403);
    }

    const installation = await db.vercelInstallation.findUnique({
        where: { vercelInstallationId: installationId },
    });

    if (installation == null) {
        return c.json({ error: "Installation not found" }, 404);
    }

    return c.json({
        timestamp: new Date().toISOString(),
        balances: [
            {
                resourceId: `provision_${installationId}_${Date.now()}`,
                currencyValueInCents: 0,
            },
        ],
    });
});

// POST /:installationId/resources - Create/provision a resource
vercelInstallationsRouter.post("/:installationId/resources", async (c) => {
    const { installationId } = c.req.param();
    logger.info("POST resource", { installationId });

    const auth = await authenticateVercelRequest(c);
    if (!auth.success) {
        return c.json({ error: auth.error }, 401);
    }
    if (installationMismatch(auth, installationId)) {
        logger.warn("POST resource: JWT installationId does not match path", {
            installationId,
            authInstallationId: auth.installationId,
        });
        return c.json({ error: "Installation mismatch" }, 403);
    }

    const installation = await db.vercelInstallation.findUnique({
        where: { vercelInstallationId: installationId },
    });

    if (installation == null) {
        return c.json({ error: "Installation not found" }, 404);
    }

    // Check only one resource per installation
    const existingResource = await db.vercelResource.findFirst({
        where: { vercelInstallationId: installation.id },
    });

    if (existingResource != null) {
        logger.warn("Resource already exists for installation", { installationId });
        return c.json({ error: "Only one resource per installation is allowed" }, 409);
    }

    const body = PostResourceBodySchema.parse(
        await c.req.json<unknown>().catch((error) => {
            logger.warn("Could not parse request body, using defaults", { error });
            return {};
        }),
    );

    const productId = body.productId ?? "autonoma-testing";
    const name = body.name ?? "Autonoma Testing";

    const plan =
        body.billingPlanId != null
            ? await db.vercelBillingPlan.findUnique({ where: { id: body.billingPlanId } })
            : await getDefaultPlan();

    if (plan == null) {
        return c.json({ error: "No billing plan available" }, 400);
    }

    const resource = await db.$transaction(async (tx) => {
        const created = await tx.vercelResource.create({
            data: {
                resourceId: crypto.randomUUID(),
                vercelInstallationId: installation.id,
                productId,
                name,
                status: "ready",
                billingPlanId: plan.id,
                metadata: body.metadata ?? null,
            },
        });

        logger.info("Resource created", { resourceId: created.resourceId, installationId });

        // Mark installation as active and assign the plan
        await tx.vercelInstallation.update({
            where: { id: installation.id },
            data: { status: "active", billingPlanId: plan.id },
        });

        // Ensure billing customer exists for Vercel provider
        const existingCustomer = await tx.billingCustomer.findUnique({
            where: { organizationId: installation.organizationId },
            select: { id: true },
        });
        if (existingCustomer == null) {
            await tx.billingCustomer.create({
                data: { organizationId: installation.organizationId, provider: "vercel" },
            });
        }

        logger.info("Billing customer ensured for Vercel installation", {
            organizationId: installation.organizationId,
        });

        return created;
    });

    // Independent post-creation side effects: syncing plan pricing and creating
    // the resource's API key secrets touch unrelated rows, so they run concurrently.
    const [, secrets] = await Promise.all([
        syncVercelPlanPricing(installation.organizationId, plan.creditsPerCycle),
        createResourceSecrets(installation.organizationId),
    ]);

    // Create billing period and invoice
    await createBillingPeriod(installation.id, plan.id, resource.id, true);

    if (secrets == null) {
        // Falling back to organizationId/"" here would hand Vercel a
        // non-functional credential with no signal that anything went wrong -
        // the customer's app would get an AUTONOMA_SECRET_ID that can never
        // authenticate. The resource row itself is already created at this
        // point (retry-safe: the "only one resource per installation" guard
        // above will find this same row), so surface a clear error instead of
        // silently shipping broken secrets.
        logger.error("Failed to provision resource secrets - refusing to return a non-functional API key", {
            installationId,
            resourceId: resource.id,
            organizationId: installation.organizationId,
        });
        return c.json({ error: "Failed to provision credentials for this resource" }, 500);
    }

    return c.json(
        {
            id: resource.id,
            productId: resource.productId,
            name: resource.name,
            metadata: resource.metadata,
            status: resource.status,
            billingPlan: {
                id: plan.id,
                name: plan.name,
                type: plan.type,
                scope: plan.scope,
                description: plan.description ?? null,
            },
            secrets: [
                { name: "AUTONOMA_CLIENT_ID", value: secrets.clientId },
                { name: "AUTONOMA_SECRET_ID", value: secrets.secretId },
            ],
        },
        201,
    );
});

// PATCH /:installationId/resources/:resourceId - Update resource name/plan
vercelInstallationsRouter.patch("/:installationId/resources/:resourceId", async (c) => {
    const { installationId, resourceId } = c.req.param();
    logger.info("PATCH resource", { installationId, resourceId });

    const auth = await authenticateVercelRequest(c);
    if (!auth.success) {
        return c.json({ error: auth.error }, 401);
    }
    if (installationMismatch(auth, installationId)) {
        logger.warn("PATCH resource: JWT installationId does not match path", {
            installationId,
            authInstallationId: auth.installationId,
        });
        return c.json({ error: "Installation mismatch" }, 403);
    }

    const installation = await db.vercelInstallation.findUnique({
        where: { vercelInstallationId: installationId },
    });

    if (installation == null) {
        return c.json({ error: "Installation not found" }, 404);
    }

    const resource = await db.vercelResource.findFirst({
        where: { id: resourceId, vercelInstallationId: installation.id },
    });

    if (resource == null) {
        return c.json({ error: "Resource not found" }, 404);
    }

    const body = PatchResourceBodySchema.parse(
        await c.req.json<unknown>().catch((error) => {
            logger.warn("Could not parse request body, using defaults", { error });
            return {};
        }),
    );

    const updateData: { name?: string; billingPlanId?: string } = {};
    if (body.name != null) updateData.name = body.name;
    let newPlanCreditsPerCycle: number | undefined;
    if (body.billingPlanId != null) {
        const plan = await db.vercelBillingPlan.findUnique({ where: { id: body.billingPlanId } });
        if (plan == null) {
            return c.json({ error: "Billing plan not found" }, 404);
        }
        updateData.billingPlanId = body.billingPlanId;
        newPlanCreditsPerCycle = plan.creditsPerCycle;
    }

    const updated = await db.vercelResource.update({
        where: { id: resource.id },
        data: updateData,
        include: { billingPlan: true },
    });

    if (newPlanCreditsPerCycle != null) {
        await syncVercelPlanPricing(installation.organizationId, newPlanCreditsPerCycle);
    }

    logger.info("Resource updated", { resourceId });

    return c.json({
        id: updated.id,
        name: updated.name,
        status: updated.status,
        billingPlan:
            updated.billingPlan != null
                ? {
                      id: updated.billingPlan.id,
                      name: updated.billingPlan.name,
                      type: updated.billingPlan.type,
                      scope: updated.billingPlan.scope,
                      description: updated.billingPlan.description ?? null,
                  }
                : null,
    });
});

// DELETE /:installationId/resources/:resourceId - Delete resource
vercelInstallationsRouter.delete("/:installationId/resources/:resourceId", async (c) => {
    const { installationId, resourceId } = c.req.param();
    logger.info("DELETE resource", { installationId, resourceId });

    const auth = await authenticateVercelRequest(c);
    if (!auth.success) {
        return c.json({ error: auth.error }, 401);
    }
    if (installationMismatch(auth, installationId)) {
        logger.warn("DELETE resource: JWT installationId does not match path", {
            installationId,
            authInstallationId: auth.installationId,
        });
        return c.json({ error: "Installation mismatch" }, 403);
    }

    const installation = await db.vercelInstallation.findUnique({
        where: { vercelInstallationId: installationId },
    });

    if (installation == null) {
        return c.json({ error: "Installation not found" }, 404);
    }

    const resource = await db.vercelResource.findFirst({
        where: { id: resourceId, vercelInstallationId: installation.id },
    });

    if (resource == null) {
        logger.warn("DELETE resource not found", { installationId, resourceId });
        return c.json({ ok: true });
    }

    await db.$transaction(async (tx) => {
        // Cancel billing periods for resource
        await tx.vercelBillingPeriod.updateMany({
            where: { resourceId: resource.id, status: "active" },
            data: { status: VercelBillingPeriodStatus.cancelled },
        });

        await tx.vercelResource.delete({ where: { id: resource.id } });
    });

    logger.info("Resource deleted", { resourceId, installationId });

    return c.json({ ok: true });
});

// GET /:installationId/resources/:resourceId - Get resource
vercelInstallationsRouter.get("/:installationId/resources/:resourceId", async (c) => {
    const { installationId, resourceId } = c.req.param();
    logger.info("GET resource", { installationId, resourceId });

    const auth = await authenticateVercelRequest(c);
    if (!auth.success) {
        return c.json({ error: auth.error }, 401);
    }
    if (installationMismatch(auth, installationId)) {
        logger.warn("GET resource: JWT installationId does not match path", {
            installationId,
            authInstallationId: auth.installationId,
        });
        return c.json({ error: "Installation mismatch" }, 403);
    }

    const installation = await db.vercelInstallation.findUnique({
        where: { vercelInstallationId: installationId },
    });

    if (installation == null) {
        return c.json({ error: "Installation not found" }, 404);
    }

    const resource = await db.vercelResource.findFirst({
        where: { id: resourceId, vercelInstallationId: installation.id },
        include: { billingPlan: true },
    });

    if (resource == null) {
        return c.json({ error: "Resource not found" }, 404);
    }

    return c.json({
        id: resource.id,
        name: resource.name,
        status: resource.status,
        billingPlan:
            resource.billingPlan != null
                ? {
                      id: resource.billingPlan.id,
                      name: resource.billingPlan.name,
                      type: resource.billingPlan.type,
                      scope: resource.billingPlan.scope,
                      description: resource.billingPlan.description ?? null,
                  }
                : null,
    });
});

// ─── Products router ──────────────────────────────────────────────────────────

export const vercelProductsRouter = new Hono();

// GET /v1/products/:productId/plans - Called by Vercel UI to list plans for a product
vercelProductsRouter.get("/:productId/plans", async (c) => {
    const { productId } = c.req.param();
    logger.info("GET product plans", { productId });

    const auth = await authenticateVercelRequest(c);
    if (!auth.success) {
        return c.json({ error: auth.error }, 401);
    }

    const plans = await db.vercelBillingPlan.findMany({
        orderBy: [{ level: "asc" }, { name: "asc" }],
    });

    return c.json({
        plans: plans.map((plan) => ({
            id: plan.id,
            name: plan.name,
            type: plan.type,
            scope: plan.scope,
            description: plan.description,
            cost: plan.cost,
            paymentMethodRequired: plan.paymentMethodRequired,
            preauthorizationAmount:
                plan.preauthorizationAmount != null ? parseFloat(plan.preauthorizationAmount.toString()) : 0,
        })),
    });
});
