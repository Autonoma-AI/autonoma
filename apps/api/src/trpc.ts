import {
    APIError,
    BadRequestError,
    ConflictError,
    InsufficientCreditsError,
    InternalError,
    NotFoundError,
    SubscriptionGracePeriodExpiredError,
} from "@autonoma/errors";
import { logger } from "@autonoma/logger";
import * as Sentry from "@sentry/node";
import { TRPCError, initTRPC } from "@trpc/server";
import superjson from "superjson";
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
];

const sentryMiddleware = t.middleware(Sentry.trpcMiddleware({ attachRpcInput: true }));

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
                organizationId: ctx.session.activeOrganizationId,
            },
        });
    });

export const internalProcedure = protectedProcedure.use(async ({ ctx, next }) => {
    if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Internal access required" });
    }
    return next({ ctx });
});
