import { CreditTransactionType, db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { EncryptionHelper } from "@autonoma/utils";
import { captureCheckIn } from "@sentry/node";
import { env } from "../env";

const logger = rootLogger.child({ name: "VercelUsageReporter" });
const encryptionHelper = new EncryptionHelper(env.VERCEL_ENCRYPTION_KEY);

const JOB_NAME = "vercel-usage-reporter";
const VERCEL_BILLING_API = "https://api.vercel.com/v1";
const INSTALLATION_BATCH_SIZE = 50;

interface BillingPayload {
    timestamp: string;
    eod: string;
    period: { start: string; end: string };
    billing: Array<{
        billingPlanId: string;
        resourceId: string;
        start: string;
        end: string;
        name: string;
        details: string;
        price: string;
        quantity: number;
        units: string;
        total: string;
    }>;
    usage: Array<{
        resourceId: string;
        name: string;
        type: string;
        units: string;
        dayValue: number;
        periodValue: number;
        planValue?: number | null;
    }>;
}

async function main() {
    const mainCheckInId = captureCheckIn({
        monitorSlug: JOB_NAME,
        status: "in_progress",
    });

    try {
        await report();
        captureCheckIn({
            checkInId: mainCheckInId,
            monitorSlug: JOB_NAME,
            status: "ok",
        });
    } catch (error) {
        logger.error("Error while running usage-reporter", { error });
        captureCheckIn({
            checkInId: mainCheckInId,
            monitorSlug: JOB_NAME,
            status: "error",
        });
        throw error;
    }
}

function parsePrice(cost: string): string {
    const match = cost.match(/[\d.]+/);
    return match != null ? match[0] : "0.00";
}

function getTodayUTC(): { start: Date; end: Date } {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    return { start, end };
}

async function calculateUsage(orgId: string, periodStart: Date, periodEnd: Date) {
    const { start: todayStart, end: todayEnd } = getTodayUTC();

    const consumptionTypes = [CreditTransactionType.RUN_CONSUMPTION, CreditTransactionType.GENERATION_CONSUMPTION];

    const [generationsToday, generationsPeriod, runsToday, runsPeriod, creditsToday, creditsPeriod] = await Promise.all(
        [
            db.testGeneration.count({
                where: { organizationId: orgId, createdAt: { gte: todayStart, lte: todayEnd } },
            }),
            db.testGeneration.count({
                where: { organizationId: orgId, createdAt: { gte: periodStart, lte: periodEnd } },
            }),
            db.run.count({
                where: {
                    organizationId: orgId,
                    createdAt: { gte: todayStart, lte: todayEnd },
                    status: { notIn: ["failed"] },
                },
            }),
            db.run.count({
                where: {
                    organizationId: orgId,
                    createdAt: { gte: periodStart, lte: periodEnd },
                    status: { notIn: ["failed"] },
                },
            }),
            db.creditTransaction.aggregate({
                where: {
                    organizationId: orgId,
                    type: { in: consumptionTypes },
                    createdAt: { gte: todayStart, lte: todayEnd },
                },
                _sum: { amount: true },
            }),
            db.creditTransaction.aggregate({
                where: {
                    organizationId: orgId,
                    type: { in: consumptionTypes },
                    createdAt: { gte: periodStart, lte: periodEnd },
                },
                _sum: { amount: true },
            }),
        ],
    );

    return {
        generations: { dayValue: generationsToday, periodValue: generationsPeriod },
        runs: { dayValue: runsToday, periodValue: runsPeriod },
        credits: {
            dayValue: Math.abs(creditsToday._sum.amount ?? 0),
            periodValue: Math.abs(creditsPeriod._sum.amount ?? 0),
        },
    };
}

async function generatePayload(installationId: string): Promise<BillingPayload | undefined> {
    const installation = await db.vercelInstallation.findUnique({
        where: { id: installationId },
        include: {
            billingPlan: true,
            billingPeriods: {
                where: { status: "active" },
                orderBy: { startDate: "desc" },
                take: 1,
            },
        },
    });

    if (installation == null || installation.billingPeriods.length === 0 || installation.billingPlan == null) {
        return undefined;
    }

    const period = installation.billingPeriods[0];
    if (period == null) {
        return undefined;
    }

    const now = new Date();

    if ((now.getTime() - period.endDate.getTime()) / (1000 * 60 * 60) > 24) {
        return undefined;
    }

    const plan = installation.billingPlan;
    const usage = await calculateUsage(installation.organizationId, period.startDate, period.endDate);

    const eod = new Date(now);
    eod.setUTCHours(23, 59, 59, 999);

    if (eod > period.endDate) {
        eod.setTime(period.endDate.getTime());
    }

    const price = parsePrice(plan.cost);

    if (period.resourceId == null) {
        logger.warn("No resourceId for billing period", { billingPeriodId: period.id });
        return undefined;
    }

    return {
        timestamp: now.toISOString(),
        eod: eod.toISOString(),
        period: {
            start: period.startDate.toISOString(),
            end: period.endDate.toISOString(),
        },
        billing: [
            {
                billingPlanId: plan.id,
                resourceId: period.resourceId,
                start: period.startDate.toISOString(),
                end: period.endDate.toISOString(),
                name: plan.name,
                details: plan.description,
                price,
                quantity: 1,
                units: "subscription",
                total: price,
            },
        ],
        usage: [
            {
                resourceId: period.resourceId,
                name: "Credits Used",
                type: "interval",
                units: "credits",
                dayValue: usage.credits.dayValue,
                periodValue: usage.credits.periodValue,
                planValue: plan.creditsPerCycle > 0 ? plan.creditsPerCycle : null,
            },
            {
                resourceId: period.resourceId,
                name: "Generations",
                type: "interval",
                units: "count",
                dayValue: usage.generations.dayValue,
                periodValue: usage.generations.periodValue,
            },
            {
                resourceId: period.resourceId,
                name: "Runs",
                type: "interval",
                units: "count",
                dayValue: usage.runs.dayValue,
                periodValue: usage.runs.periodValue,
            },
        ],
    };
}

async function submitToVercel(installationId: string, accessToken: string, payload: BillingPayload): Promise<boolean> {
    const url = `${VERCEL_BILLING_API}/installations/${installationId}/billing`;

    logger.info("Submitting payload to Vercel", { installationId });

    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });
    } catch (error) {
        logger.error("Network error submitting billing data to Vercel", { installationId, url, error });
        return false;
    }

    if (!res.ok) {
        const errorText = await res.text();
        logger.error("Vercel API error", { status: res.status, text: errorText });
        return false;
    }

    logger.info("Successfully submitted billing data", { installationId });
    return true;
}

async function report() {
    logger.info("Starting billing submission", { timestamp: new Date().toISOString() });

    let success = 0;
    let failed = 0;
    let skipped = 0;
    let processed = 0;
    let cursor: string | undefined;

    // Cursor-paginate instead of loading every active installation into memory
    // up front - the previous `findMany` with no `take` pulled the whole table
    // in one query, and the batch loop below only ever chunked that
    // already-fully-loaded array for concurrency, not for the DB read itself.
    for (;;) {
        const batch = await db.vercelInstallation.findMany({
            where: { status: "active", accessTokenEnc: { not: null } },
            select: { id: true, vercelInstallationId: true, accessTokenEnc: true },
            orderBy: { id: "asc" },
            take: INSTALLATION_BATCH_SIZE,
            ...(cursor != null ? { cursor: { id: cursor }, skip: 1 } : {}),
        });

        if (batch.length === 0) break;
        cursor = batch[batch.length - 1]?.id;
        processed += batch.length;

        const results = await Promise.allSettled(
            batch.map(async (inst) => {
                const payload = await generatePayload(inst.id);

                if (payload == null || inst.accessTokenEnc == null) {
                    return "skipped";
                }

                const accessToken = encryptionHelper.decrypt(inst.accessTokenEnc);
                const submitted = await submitToVercel(inst.vercelInstallationId, accessToken, payload);
                return submitted ? "success" : "failed";
            }),
        );

        for (const result of results) {
            if (result.status !== "fulfilled") {
                failed++;
            } else if (result.value === "success") {
                success++;
            } else if (result.value === "skipped") {
                skipped++;
            } else {
                failed++;
            }
        }

        if (batch.length < INSTALLATION_BATCH_SIZE) break;
    }

    logger.info("Complete", { success, failed, skipped, processed });
}

main()
    .then(async () => {
        await db.$disconnect();
        process.exit(0);
    })
    .catch(async (error) => {
        logger.error("Fatal error in main", { error });
        await db.$disconnect();
        process.exit(1);
    });
