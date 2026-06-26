import {
    APIError,
    BadRequestError,
    ConflictError,
    InsufficientCreditsError,
    InternalError,
    NotFoundError,
    SubscriptionGracePeriodExpiredError,
    TestQuarantinedError,
} from "@autonoma/errors";
import { logger } from "@autonoma/logger";
import * as Sentry from "@sentry/node";
import { TRPCError, initTRPC } from "@trpc/server";
import superjson from "superjson";
import { isInternalEmail } from "./auth";
import type { Context } from "./context";

export const t = initTRPC.context<Context>().create({ transformer: superjson });

type TRPCErrorCode = ConstructorParameters<typeof TRPCError>[0]["code"];
type APIErrorCtor = new (...args: never[]) => APIError;

const apiErrorToTrpcCode: Array<{ ctor: APIErrorCtor; code: TRPCErrorCode }> = [
    { ctor: NotFoundError, code: "NOT_FOUND" },
    { ctor: ConflictError, code: "CONFLICT" },
    { ctor: BadRequestError, code: "BAD_REQUEST" },
    { ctor: InternalError, code: "INTERNAL_SERVER_ERROR" },
    { ctor: InsufficientCreditsError, code: "PRECONDITION_FAILED" },
    { ctor: SubscriptionGracePeriodExpiredError, code: "PRECONDITION_FAILED" },
    { ctor: TestQuarantinedError, code: "PRECONDITION_FAILED" },
];

const sentryMiddleware = t.middleware(Sentry.trpcMiddleware({ attachRpcInput: true }));

const loggerMiddleware = t.middleware(async ({ ctx, next, path, type }) => {
    const organizationId = ctx.session?.activeOrganizationId;
    const userId = ctx.user?.id;

    if (organizationId != null) Sentry.getCurrentScope().setTag("organizationId", organizationId);
    if (userId != null) Sentry.getCurrentScope().setTag("userId", userId);

    const start = Date.now();
    const result = await next();
    logger.info(`tRPC ${type} ${path}`, {
        procedure: path,
        type,
        organizationId,
        userId,
        durationMs: Date.now() - start,
        ok: result.ok,
    });
    return result;
});

const errorMiddleware = t.middleware(async ({ next, path }) => {
    const result = await next();

    if (!result.ok) {
        const cause = result.error.cause;

        if (!(cause instanceof APIError)) {
            logger.fatal(`Unhandled error in procedure: ${path}`, result.error);
        }
        if (cause instanceof APIError) {
            const mapped = apiErrorToTrpcCode.find((entry) => cause instanceof entry.ctor);
            if (mapped != null) {
                throw new TRPCError({ code: mapped.code, message: cause.message, cause });
            }
        }
    }

    return result;
});

export const router = t.router;
export const publicProcedure = t.procedure.use(sentryMiddleware).use(errorMiddleware);

export const protectedProcedure = t.procedure
    .use(sentryMiddleware)
    .use(errorMiddleware)
    .use(async ({ ctx, next }) => {
        if (ctx.user == null || ctx.session == null || ctx.session.activeOrganizationId == null) {
            throw new TRPCError({ code: "UNAUTHORIZED" });
        }
        return next({
            ctx: {
                ...ctx,
                user: ctx.user,
                // Re-forward the narrowed, non-null session so downstream
                // procedures get a guaranteed `session` (e.g. session.token)
                // without re-checking for null.
                session: ctx.session,
                organizationId: ctx.session.activeOrganizationId,
            },
        });
    })
    .use(loggerMiddleware);

export const internalProcedure = protectedProcedure.use(async ({ ctx, next }) => {
    if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Internal access required" });
    }
    return next({ ctx });
});

/** Gated on the Autonoma-internal email domain (@autonoma.app) rather than the admin role - for surfaces
 * (like the shadow investigation report) shown only to Autonoma staff, regardless of their org role. */
export const internalEmailProcedure = protectedProcedure.use(async ({ ctx, next }) => {
    if (!isInternalEmail(ctx.user.email)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Internal access required" });
    }
    return next({ ctx });
});
