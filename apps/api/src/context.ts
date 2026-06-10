import { verifyApiKey } from "@autonoma/auth";
import { db } from "@autonoma/db";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { S3Storage } from "@autonoma/storage";
import { TemporalGenerationProvider } from "@autonoma/test-updates/temporal";
import {
    cancelDiffsJob,
    triggerDiffsJob,
    triggerGenerationReviewWorkflow,
    triggerPreviewDeploy,
    triggerPreviewTeardown,
    triggerReplayReviewWorkflow,
    triggerRunWorkflow,
} from "@autonoma/workflow";
import type { Context as HonoContext } from "hono";
import type { AuthSession, AuthUser } from "./auth";
import { buildAuth } from "./auth";
import { env } from "./env";
import { buildGitHubApp } from "./github/github-app";
import { connectRedis } from "./redis";
import { buildServices } from "./routes/build-services";

if (env.TESTING) throw new Error("Do not import context.ts in a test environment - You may need to refactor the code.");

export const storageProvider = S3Storage.createFromEnv();
export const redisClient = await connectRedis({ url: env.REDIS_URL });
export const auth = buildAuth({ redisClient, conn: db });

export const encryptionHelper = new EncryptionHelper(env.SCENARIO_ENCRYPTION_KEY);
export const scenarioManager = new ScenarioManager(db, encryptionHelper);

export const generationProvider = new TemporalGenerationProvider();

const githubApp = buildGitHubApp(env);

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

    return {
        db,
        user,
        session,
        services: buildServices({
            conn: db,
            auth,
            storageProvider,
            triggerRunWorkflow,
            triggerGenerationReview: triggerGenerationReviewWorkflow,
            triggerRunReview: triggerReplayReviewWorkflow,
            scenarioManager,
            encryptionHelper,
            generationProvider,
            githubApp,
            triggerDiffsJob,
            cancelDiffsJob,
            triggerPreviewDeploy,
            triggerPreviewTeardown,
        }),
    };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
