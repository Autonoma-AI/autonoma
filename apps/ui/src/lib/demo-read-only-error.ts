import { isTRPCClientError } from "@trpc/client";
import { z } from "zod";

/**
 * The API's `writeProcedure` rejects every mutation against the read-only demo org and
 * stamps `data.demoReadOnly = true` on the error (see the API `trpc.ts` errorFormatter).
 * This is the single, message-independent way the UI recognises that rejection so it can
 * show the "sign up to continue" modal instead of a generic error toast. Validated with
 * Zod rather than a cast because a caught error's `data` is an untyped runtime boundary.
 */
const DemoErrorDataSchema = z.object({ demoReadOnly: z.boolean().optional() });

export function isDemoReadOnlyError(error: unknown): boolean {
    if (!isTRPCClientError(error)) return false;
    const parsed = DemoErrorDataSchema.safeParse(error.data);
    return parsed.success && parsed.data.demoReadOnly === true;
}
