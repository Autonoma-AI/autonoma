import { db } from "@autonoma/db";
import { GitHubApp } from "@autonoma/github";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { S3Storage } from "@autonoma/storage";
import { type GenerationProvider, LocalGenerationProvider } from "@autonoma/test-updates";
import { ArgoGenerationProvider } from "@autonoma/test-updates/argo";
import {
    triggerDiffsJob as prodDiffPlannerWorkflow,
    triggerGenerationReviewWorkflow as prodGenerationReviewWorkflow,
    triggerReplayReviewWorkflow as prodReplayReviewWorkflow,
    triggerRunWorkflow as prodRunWorkflow,
} from "@autonoma/workflow";
import type { Context as HonoContext } from "hono";
import type { AuthSession, AuthUser } from "./auth";
import { buildAuth } from "./auth";
import { env } from "./env";
import { connectRedis } from "./redis";
import { buildServices } from "./routes/build-services";
import { triggerLocalReplayReview } from "./scripts/local-replay-review";
import { triggerLocalReview } from "./scripts/local-review";
import { triggerLocalRun } from "./scripts/local-run";

if (env.TESTING) throw new Error("Do not import context.ts in a test environment - You may need to refactor the code.");

export const triggerRunWorkflow = env.NODE_ENV === "production" ? prodRunWorkflow : triggerLocalRun;
export const triggerGenerationReview =
    env.NODE_ENV === "production" ? prodGenerationReviewWorkflow : triggerLocalReview;
export const triggerRunReview = env.NODE_ENV === "production" ? prodReplayReviewWorkflow : triggerLocalReplayReview;
export const triggerDiffPlanner =
    env.NODE_ENV === "production" ? prodDiffPlannerWorkflow : async ({ branchId: _ }: { branchId: string }) => {};

export const storageProvider = S3Storage.createFromEnv();
export const redisClient = await connectRedis({ url: env.REDIS_URL });
export const auth = buildAuth({ redisClient, conn: db });

export const encryptionHelper = new EncryptionHelper(env.SCENARIO_ENCRYPTION_KEY);
export const scenarioManager = new ScenarioManager(db, encryptionHelper);

function createGenerationProvider(): GenerationProvider {
    if (env.LOCAL_GENERATION) {
        return new LocalGenerationProvider({
            db,
            scenarioManager,
            concurrency: env.LOCAL_GENERATION_CONCURRENCY,
        });
    }

    return new ArgoGenerationProvider({ agentVersion: env.AGENT_VERSION });
}

export const generationProvider = createGenerationProvider();

const githubApp = new GitHubApp({
    appSlug: env.GITHUB_APP_SLUG,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
});

export async function createContext(c: HonoContext) {
    const rawSession = await auth.api.getSession({
        headers: c.req.raw.headers,
    });

    return {
        db,
        user: (rawSession?.user ?? null) as AuthUser | null,
        session: (rawSession?.session ?? null) as AuthSession | null,
        services: buildServices({
            conn: db,
            auth,
            storageProvider,
            triggerRunWorkflow,
            triggerGenerationReview,
            triggerRunReview,
            triggerDiffPlanner,
            scenarioManager,
            encryptionHelper,
            generationProvider,
            githubApp,
        }),
    };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
