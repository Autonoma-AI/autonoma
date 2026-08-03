import { verifyApiKey } from "@autonoma/auth";
import { createBillingService } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { S3Storage } from "@autonoma/storage";
import { TemporalGenerationProvider } from "@autonoma/test-updates/temporal";
import { temporalPipelineWorkflows } from "@autonoma/workflow";
import type { Context as HonoContext } from "hono";
import type { AuthSession, AuthUser } from "./auth";
import { buildAuth } from "./auth";
import { encryptionHelper } from "./encryption";
import { env } from "./env";
import { buildGitHubApp } from "./github/github-app";
import { resolvePreviewkitTriggers } from "./previewkit/previewkit-triggers";
import { connectRedis } from "./redis";
import { buildServices } from "./routes/build-services";

if (env.TESTING) throw new Error("Do not import context.ts in a test environment - You may need to refactor the code.");

export const storageProvider = S3Storage.createFromEnv();
export const redisClient = await connectRedis({ url: env.REDIS_URL });
export const auth = buildAuth({ redisClient, conn: db });

export { encryptionHelper };
export const scenarioManager = new ScenarioManager(db, encryptionHelper);

// VERCEL_ENCRYPTION_KEY is optional (Vercel Marketplace is an opt-in
// integration), so this is built lazily and only throws when a Vercel route
// actually needs it - never at API startup - unlike `encryptionHelper` above,
// which backs the always-on scenario SDK and is required.
let vercelEncryptionHelperInstance: EncryptionHelper | undefined;

export function getVercelEncryptionHelper(): EncryptionHelper {
    if (vercelEncryptionHelperInstance != null) return vercelEncryptionHelperInstance;
    if (env.VERCEL_ENCRYPTION_KEY == null) {
        throw new Error("VERCEL_ENCRYPTION_KEY is not configured - the Vercel Marketplace integration is disabled");
    }
    vercelEncryptionHelperInstance = new EncryptionHelper(env.VERCEL_ENCRYPTION_KEY);
    return vercelEncryptionHelperInstance;
}

export const generationProvider = new TemporalGenerationProvider();

// Billing service for the managed LLM proxy (planner CLI) credit gate +
// metering. The tRPC layer builds its own instance via build-services; the raw
// Hono proxy router needs one too. Stateless wrapper over `db`.
export const billingService = createBillingService(db);

const githubApp = buildGitHubApp(env);

// Launches the preview lifecycle (deploy / teardown / per-app redeploy) as Kubernetes Jobs.
const previewkitTriggers = resolvePreviewkitTriggers();

/**
 * The DB handle and the fully-wired service graph, with no authentication performed.
 * For callers that already authenticated the request themselves and would otherwise pay
 * for a second, discarded auth pass - notably the MCP surface, which verifies its own
 * bearer in middleware and never reads `user`/`session` off the context.
 */
export function createServiceContext() {
    return {
        db,
        services: buildServices({
            conn: db,
            auth,
            redisClient,
            storageProvider,
            scenarioManager,
            encryptionHelper,
            getVercelEncryptionHelper,
            generationProvider,
            githubApp,
            pipelineWorkflows: temporalPipelineWorkflows,
            triggerPreviewDeploy: previewkitTriggers.deploy,
            triggerPreviewTeardown: previewkitTriggers.teardown,
            triggerPreviewRedeployApp: previewkitTriggers.redeployApp,
        }),
    };
}

export async function createContext(c: HonoContext) {
    const rawSession = await auth.api.getSession({
        headers: c.req.raw.headers,
    });

    let user: AuthUser | null = (rawSession?.user ?? null) as AuthUser | null;
    let session: AuthSession | null = (rawSession?.session ?? null) as AuthSession | null;

    if (user == null) {
        const keyCtx = await verifyApiKey(db, c.req.header("authorization"));
        if (keyCtx != null) {
            const dbUser = await db.user.findUnique({ where: { id: keyCtx.userId } });
            if (dbUser != null) {
                user = dbUser as unknown as AuthUser;
                session = { activeOrganizationId: keyCtx.organizationId } as unknown as AuthSession;
            }
        }
    }

    const { services } = createServiceContext();
    return { db, user, session, services };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
