import { logger as rootLogger } from "@autonoma/logger";
import type { Context } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { env } from "../env";

const logger = rootLogger.child({ name: "VercelAuth" });

// Vercel issues two distinct OIDC token shapes for partner-API requests:
// - User Auth: a specific user acted (install, config change) - carries user_id/user_role.
// - System Auth: the integration account itself acted (e.g. listing product plans before
//   any installation exists) - has no user context at all, and installation_id may be null.
// A single schema requiring user_id/user_role rejects every System Auth token with a Zod
// error, which is why account/system-level calls (like GET /v1/products/:id/plans) were
// failing auth entirely. See:
// https://vercel.com/docs/integrations/create-integration/marketplace-api/reference/partner
const UserAuthPayloadSchema = z.object({
    account_id: z.string(),
    installation_id: z.string(),
    user_id: z.string(),
    user_email: z.string().optional(),
    user_role: z.enum(["ADMIN", "USER"]),
    user_name: z.string().optional(),
    user_avatar_url: z.string().optional(),
});

const SystemAuthPayloadSchema = z.object({
    account_id: z.string(),
    installation_id: z.string().nullable(),
});

export type VercelJwtPayload = z.infer<typeof UserAuthPayloadSchema>;

interface AuthSuccess {
    success: true;
    authType: "user" | "system";
    installationId: string | undefined;
    accountId: string;
    // Only present for User Auth tokens - undefined for System Auth (no user context ).
    userId: string | undefined;
    userEmail: string | undefined;
    userRole: "ADMIN" | "USER" | undefined;
    userName: string | undefined;
}

interface AuthFailure {
    success: false;
    error: string;
}

export type VercelAuthResult = AuthSuccess | AuthFailure;

const JWKS = createRemoteJWKSet(new URL("https://marketplace.vercel.com/.well-known/jwks.json"));

export async function authenticateVercelRequest(c: Context): Promise<VercelAuthResult> {
    const authHeader = c.req.header("authorization");

    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
        return { success: false, error: "Missing authorization header" };
    }

    const token = authHeader.slice(7);

    try {
        if (env.VERCEL_CLIENT_ID == null) {
            return { success: false, error: "VERCEL_CLIENT_ID not configured" };
        }

        const { payload } = await jwtVerify(token, JWKS, {
            audience: env.VERCEL_CLIENT_ID,
            issuer: "https://marketplace.vercel.com",
            algorithms: ["RS256"],
        });

        const userAuth = UserAuthPayloadSchema.safeParse(payload);
        if (userAuth.success) {
            logger.info("Vercel JWT verified (user auth)", {
                accountId: userAuth.data.account_id,
                userId: userAuth.data.user_id,
            });
            return {
                success: true,
                authType: "user",
                installationId: userAuth.data.installation_id,
                accountId: userAuth.data.account_id,
                userId: userAuth.data.user_id,
                userEmail: userAuth.data.user_email,
                userRole: userAuth.data.user_role,
                userName: userAuth.data.user_name,
            };
        }

        const systemAuth = SystemAuthPayloadSchema.parse(payload);
        logger.info("Vercel JWT verified (system auth)", { accountId: systemAuth.account_id });
        return {
            success: true,
            authType: "system",
            installationId: systemAuth.installation_id ?? undefined,
            accountId: systemAuth.account_id,
            userId: undefined,
            userEmail: undefined,
            userRole: undefined,
            userName: undefined,
        };
    } catch (error) {
        logger.warn("Vercel JWT verification failed", { error });
        return { success: false, error: error instanceof Error ? error.message : "JWT verification failed" };
    }
}
