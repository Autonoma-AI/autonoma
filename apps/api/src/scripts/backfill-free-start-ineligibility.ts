/**
 * Seeds `free_start_ineligibility` from the grants that already happened.
 *
 * Without this the rule only binds people who sign up from now on: every existing account that already
 * has its 100,000 would be entitled to another one via a Vercel team. Reads every FREE_START_GRANT,
 * takes the members of those organizations, and records one row per address.
 *
 * Idempotent - `recordFreeStartIneligibility` appends and de-duplicates - so it can be re-run. Prints
 * what it would do unless APPLY=1.
 */
import { recordFreeStartIneligibility } from "@autonoma/billing";
import { createClient } from "@autonoma/db";

const apply = process.env.APPLY === "1";
const internalDomain = (process.env.INTERNAL_DOMAIN ?? "autonoma.app").trim().toLowerCase();
const db = createClient(process.env.DATABASE_URL ?? "");

try {
    const grants = await db.creditTransaction.findMany({
        where: { type: "FREE_START_GRANT" },
        select: { organizationId: true },
    });
    const organizationIds = [...new Set(grants.map((row) => row.organizationId))];
    console.log(`${apply ? "APPLYING" : "DRY RUN"} - ${organizationIds.length} organizations hold a starting grant`);

    let recorded = 0;
    let skippedStaff = 0;
    for (const organizationId of organizationIds) {
        const members = await db.member.findMany({
            where: { organizationId },
            select: { user: { select: { email: true } } },
        });
        for (const member of members) {
            const email = member.user.email.trim().toLowerCase();
            // Staff hold memberships in customer organizations through `admin.switchToOrg`; they are not
            // people spending a trial, and marking them would deny them one for real work later.
            if (email.endsWith(`@${internalDomain}`)) {
                skippedStaff++;
                continue;
            }
            recorded++;
            if (apply) await recordFreeStartIneligibility(db, email, organizationId);
        }
    }

    console.log(`addresses to record: ${recorded}  (staff memberships skipped: ${skippedStaff})`);
    if (apply) {
        const rows = await db.freeStartIneligibility.count();
        console.log(`free_start_ineligibility now holds ${rows} addresses`);
    }
} finally {
    await db.$disconnect();
}
