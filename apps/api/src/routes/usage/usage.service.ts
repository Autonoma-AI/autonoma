import type { BillingService } from "@autonoma/billing";
import { computePreviewUsageCost } from "@autonoma/billing";
import type { Prisma, PrismaClient } from "@autonoma/db";
import { Service } from "../service";

export interface BranchAiCostTag {
    tag: string;
    calls: number;
    costMicrodollars: number;
    inputTokens: number;
    outputTokens: number;
}

export interface BranchAiCostSummary {
    totalCalls: number;
    totalCostMicrodollars: number;
    byTag: BranchAiCostTag[];
}

function mergeByTag(tags: readonly BranchAiCostTag[]): BranchAiCostTag[] {
    const byTag = new Map<string, BranchAiCostTag>();

    for (const tag of tags) {
        const existing = byTag.get(tag.tag);
        if (existing == null) {
            byTag.set(tag.tag, tag);
            continue;
        }
        existing.calls += tag.calls;
        existing.costMicrodollars += tag.costMicrodollars;
        existing.inputTokens += tag.inputTokens;
        existing.outputTokens += tag.outputTokens;
    }

    return [...byTag.values()];
}

export interface EnvironmentComputeUsage {
    build: {
        vcpuSeconds: number;
        gbSeconds: number;
        buildCount: number;
        credits: number;
        /**
         * The real USD cost of these builds' actual instances (spot's live price, or the stable
         * on-demand price), decoupled from `credits` above - which is priced at the org's
         * deliberately-fixed `BillingPricing` rate, not what AWS actually charged. Undefined when
         * no build in the window has a recorded real cost yet.
         */
        realCostUsdMicrodollars: number | undefined;
    };
    running: { vcpuSeconds: number; gbSeconds: number; windowCount: number; credits: number };
    /**
     * The org that OWNS this environment, and whose rates the two below are read from - not
     * whichever org the viewing admin happens to be acting as. Any UI that writes a rate back must
     * target this org, or an admin switched into a different org edits the rate they are not looking at.
     */
    organizationId: string;
    organizationName: string;
    creditsPerVcpuHour: number;
    creditsPerGbMemoryHour: number;
}

/**
 * Admin-only visibility into what a branch/environment is actually costing - AI token
 * spend and Previewkit compute usage. Priced through the same functions and pricing
 * table billing itself uses, so this always agrees with (or explains) a future charge
 * rather than being a second, drifting computation.
 */
export class UsageService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly billing: BillingService,
    ) {
        super();
    }

    async branchAiCost(branchId: string): Promise<BranchAiCostSummary> {
        this.logger.info("Loading branch AI cost summary", { branchId });

        // Each `AiCostRecord` carries exactly one of these two anchors, so a single `OR` across both
        // relations would be correct - but Postgres's planner can't turn that `OR` into a combined
        // bitmap index scan across two different FK indexes: it falls back to a sequential scan of
        // the whole table (confirmed via EXPLAIN ANALYZE - ~10s over 4M+ rows, vs. ~6ms per anchor
        // when queried separately). Running the anchors as independent queries lets each one hit its
        // own index, and since the anchors are mutually exclusive the result sets never overlap -
        // summing them by tag is safe.
        const [byGeneration, byInvestigation] = await Promise.all([
            this.groupByTag({ generation: { snapshot: { branchId } } }),
            this.groupByTag({ investigationSnapshot: { branchId } }),
        ]);

        const byTag = mergeByTag([...byGeneration, ...byInvestigation]).sort(
            (a, b) => b.costMicrodollars - a.costMicrodollars,
        );

        this.logger.info("Loaded branch AI cost summary", { branchId, tags: byTag.length });

        return {
            totalCalls: byTag.reduce((sum, tag) => sum + tag.calls, 0),
            totalCostMicrodollars: byTag.reduce((sum, tag) => sum + tag.costMicrodollars, 0),
            byTag,
        };
    }

    private async groupByTag(where: Prisma.AiCostRecordWhereInput): Promise<BranchAiCostTag[]> {
        const rows = await this.db.aiCostRecord.groupBy({
            by: ["tag"],
            where,
            _count: { _all: true },
            _sum: { costMicrodollars: true, inputTokens: true, outputTokens: true },
        });

        return rows.map((row) => ({
            tag: row.tag,
            calls: row._count._all,
            costMicrodollars: row._sum.costMicrodollars ?? 0,
            inputTokens: row._sum.inputTokens ?? 0,
            outputTokens: row._sum.outputTokens ?? 0,
        }));
    }

    async environmentComputeUsage(environmentId: string): Promise<EnvironmentComputeUsage> {
        this.logger.info("Loading environment compute usage", { environmentId });

        const environment = await this.db.previewkitEnvironment.findUniqueOrThrow({
            where: { id: environmentId },
            select: { organizationId: true, organization: { select: { name: true } } },
        });

        const [buildUsage, runningUsage, pricing] = await Promise.all([
            this.db.previewkitAppBuildUsage.aggregate({
                where: { appBuild: { build: { environmentId } } },
                _count: { _all: true },
                _sum: { vcpuSeconds: true, gbSeconds: true, realCostUsdMicrodollars: true },
            }),
            this.db.previewkitUsageWindow.aggregate({
                where: { environmentId },
                _count: { _all: true },
                _sum: { vcpuSeconds: true, gbSeconds: true },
            }),
            this.billing.getPricing(environment.organizationId),
        ]);

        const buildVcpuSeconds = buildUsage._sum.vcpuSeconds ?? 0;
        const buildGbSeconds = buildUsage._sum.gbSeconds ?? 0;
        const runningVcpuSeconds = runningUsage._sum.vcpuSeconds ?? 0;
        const runningGbSeconds = runningUsage._sum.gbSeconds ?? 0;

        this.logger.info("Loaded environment compute usage", {
            environmentId,
            buildCount: buildUsage._count._all,
            windowCount: runningUsage._count._all,
        });

        return {
            build: {
                vcpuSeconds: buildVcpuSeconds,
                gbSeconds: buildGbSeconds,
                buildCount: buildUsage._count._all,
                credits: computePreviewUsageCost(buildVcpuSeconds, buildGbSeconds, pricing),
                realCostUsdMicrodollars: buildUsage._sum.realCostUsdMicrodollars ?? undefined,
            },
            running: {
                vcpuSeconds: runningVcpuSeconds,
                gbSeconds: runningGbSeconds,
                windowCount: runningUsage._count._all,
                credits: computePreviewUsageCost(runningVcpuSeconds, runningGbSeconds, pricing),
            },
            organizationId: environment.organizationId,
            organizationName: environment.organization.name,
            creditsPerVcpuHour: pricing.creditsPerVcpuHour,
            creditsPerGbMemoryHour: pricing.creditsPerGbMemoryHour,
        };
    }
}
