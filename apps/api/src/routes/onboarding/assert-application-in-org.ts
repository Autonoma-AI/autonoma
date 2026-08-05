import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";

/**
 * Authorize an operation on an application: it must belong to the caller's
 * organization, or nothing happens.
 *
 * The onboarding services take an `applicationId` from the caller and are reached
 * with a session or an API key, so this is the check that separates two
 * organizations - authentication only establishes who is asking, never what they
 * may reach. Reads that skip it are reachable by id alone.
 *
 * A missing application and one in another organization throw the same error, so
 * this can never be used to probe which application ids exist.
 *
 * Deliberately narrow: it answers "may this caller touch this app" and returns
 * nothing. The many other `findFirst({ where: { id, organizationId } })` lookups
 * around the API are not this - they fetch fields they go on to use, and folding
 * them in here would trade a real read for a second query.
 */
export async function assertApplicationInOrg(
    db: Pick<PrismaClient, "application">,
    applicationId: string,
    organizationId: string,
): Promise<void> {
    const application = await db.application.findFirst({
        where: { id: applicationId, organizationId },
        select: { id: true },
    });
    if (application == null) throw new NotFoundError("Application not found");
}
