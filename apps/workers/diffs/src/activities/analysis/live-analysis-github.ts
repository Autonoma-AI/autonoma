import { db } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { AnalysisRunOutcome } from "@autonoma/types";
import {
    loadSnapshotMeta,
    resolveGitHubAccess,
    type GitHubAccess,
    type SnapshotMeta,
} from "../../codebase/snapshot-context";
import { getStorage } from "../../services";
import type { AnalysisGitHub } from "./analysis-github";
import { concludeMergeGate } from "./apply-merge-gate-verdict";
import { postAnalysisComment } from "./post-analysis-comment";

/** The production GitHub capability for one settled analysis run. */
export class LiveAnalysisGitHub implements AnalysisGitHub {
    private readonly logger: Logger;
    private context?: Promise<GitHubSettlementContext | undefined>;

    constructor(private readonly snapshotId: string) {
        this.logger = rootLogger.child({ name: this.constructor.name, snapshotId });
    }

    public async conclude(outcome: AnalysisRunOutcome): Promise<void> {
        this.logger.info("Concluding analysis merge gate", { extra: { outcome: outcome.kind } });
        const context = await this.loadContext();
        if (context == null) return;
        await concludeMergeGate({ db, github: context.github, meta: context.meta, outcome });
        this.logger.info("Concluded analysis merge gate", { extra: { outcome: outcome.kind } });
    }

    public async comment(outcome: Extract<AnalysisRunOutcome, { kind: "succeeded" }>): Promise<void> {
        this.logger.info("Posting analysis PR comment");
        const context = await this.loadContext();
        if (context == null) return;
        await postAnalysisComment({ db, github: context.github, storage: getStorage(), meta: context.meta, outcome });
        this.logger.info("Posted analysis PR comment");
    }

    private async loadContext(): Promise<GitHubSettlementContext | undefined> {
        this.context ??= loadGitHubSettlementContext(this.snapshotId);
        return await this.context;
    }
}

interface GitHubSettlementContext {
    meta: SnapshotMeta;
    github: GitHubAccess;
}

async function loadGitHubSettlementContext(snapshotId: string): Promise<GitHubSettlementContext | undefined> {
    const logger = rootLogger.child({ name: "loadGitHubSettlementContext", snapshotId });
    try {
        const meta = await loadSnapshotMeta(snapshotId);
        const github = await resolveGitHubAccess(meta);
        return { meta, github };
    } catch (error) {
        logger.error("Could not resolve GitHub access for analysis settlement", { extra: { err: error } });
        return undefined;
    }
}
