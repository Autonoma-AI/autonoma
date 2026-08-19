import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger, type Logger } from "@autonoma/logger";
import type { PreviewNamespaces } from "./preview-namespaces";

/** How long a preview namespace lives before the sweep reclaims it. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The base preview, which has no pull request behind it to close and is not
 * reclaimed by age. The suffix is how the namespace name encodes that.
 */
const BASE_PREVIEW_SUFFIX = "-pr-0";

export interface ReapOutcome {
    /** Rows the database called live whose namespace was already gone. Bookkeeping only. */
    markedGone: number;
    /** Namespaces past the TTL, deleted and marked in the same pass. */
    reaped: number;
    /** Namespaces past the TTL with no live row left to mark - deleted, nothing to record. */
    deletedWithoutRow: number;
    /** Live rows whose namespace is present and inside the TTL. Left alone. */
    healthy: number;
}

export interface ReapOptions {
    /** Report what would happen and write nothing. */
    dryRun?: boolean;
}

/**
 * Reconciles preview environments against the cluster that actually holds them.
 *
 * These two used to be managed by different things that never spoke: a shell
 * CronJob deleted any preview namespace older than a week, straight through
 * kubectl, while only the `pull_request.closed` webhook ever set `tornDownAt`. A
 * namespace reclaimed by age left its row saying `ready` forever - 814 of 1,438
 * live-looking rows had no namespace behind them, 423 of those still claiming
 * `ready`, which is what the dashboard and the usage meter were reading.
 *
 * One pass now owns both sides, so a namespace cannot go without its row being
 * told. The TTL is unchanged: this makes the database honest about the policy
 * rather than changing it.
 */
export class PreviewReaper {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly namespaces: PreviewNamespaces,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async run(now: Date, options: ReapOptions = {}): Promise<ReapOutcome> {
        const dryRun = options.dryRun === true;
        this.logger.info("Reconciling preview environments against the cluster", { extra: { dryRun } });

        const [live, present] = await Promise.all([
            this.db.previewkitEnvironment.findMany({
                where: { tornDownAt: null },
                select: { id: true, namespace: true },
            }),
            this.namespaces.list(),
        ]);

        const byName = new Map(present.map((namespace) => [namespace.name, namespace]));
        const liveNamespaces = new Set(live.map((environment) => environment.namespace));
        const outcome: ReapOutcome = { markedGone: 0, reaped: 0, deletedWithoutRow: 0, healthy: 0 };
        const goneIds: string[] = [];

        for (const environment of live) {
            const namespace = byName.get(environment.namespace);

            if (namespace == null) {
                // The namespace is already gone - by the old cron, by hand, or with the
                // cluster. Nothing to delete; the row is simply wrong. Collected rather
                // than written one at a time: the first run has ~800 of these, and they
                // are independent rows the database can settle in one statement.
                outcome.markedGone += 1;
                goneIds.push(environment.id);
                continue;
            }
            if (!this.isExpired(namespace.createdAt, namespace.name, now)) {
                outcome.healthy += 1;
                continue;
            }

            // Delete BEFORE marking: a mark that lands without the delete leaves a
            // namespace nothing will ever look at again, while a delete whose mark
            // fails is picked up as `markedGone` on the next pass.
            outcome.reaped += 1;
            if (dryRun) continue;
            await this.namespaces.delete(namespace.name);
            await this.markTornDown(environment.id);
        }

        // Namespaces the rows no longer account for. The old cron deleted purely by
        // age and so collected these too; without this the replacement would leave
        // them running forever.
        for (const namespace of present) {
            if (liveNamespaces.has(namespace.name)) continue;
            if (!this.isExpired(namespace.createdAt, namespace.name, now)) continue;

            outcome.deletedWithoutRow += 1;
            if (!dryRun) await this.namespaces.delete(namespace.name);
        }

        if (goneIds.length > 0 && !dryRun) await this.markManyTornDown(goneIds);

        this.logger.info("Preview environment reconciliation complete", { extra: { ...outcome, dryRun } });
        return outcome;
    }

    private isExpired(createdAt: Date, name: string, now: Date): boolean {
        if (name.endsWith(BASE_PREVIEW_SUFFIX)) return false;
        return now.getTime() - createdAt.getTime() > MAX_AGE_MS;
    }

    /**
     * `tornDownAt: null` is in the filter as well as the id: a row something else
     * tore down while this sweep was running has a truer timestamp than the one
     * here, and must not be overwritten with a later one.
     */
    private async markManyTornDown(ids: readonly string[]): Promise<void> {
        await this.db.previewkitEnvironment.updateMany({
            where: { id: { in: [...ids] }, tornDownAt: null },
            data: { status: "torn_down", phase: "torn_down", tornDownAt: new Date() },
        });
    }

    private async markTornDown(id: string): Promise<void> {
        await this.db.previewkitEnvironment.update({
            where: { id },
            data: { status: "torn_down", phase: "torn_down", tornDownAt: new Date() },
        });
    }
}
