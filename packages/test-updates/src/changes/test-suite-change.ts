import { type Logger, logger } from "@autonoma/logger";
import type { SnapshotDraft } from "../snapshot-draft";

export interface ApplyChangeParams {
    /** An interface to the snapshot draft being updated. */
    snapshotDraft: SnapshotDraft;
}

/** Represents some update to the test suite of the application. */
export abstract class TestSuiteChange<TParams = unknown, TResult = void> {
    protected readonly logger: Logger;

    constructor(public readonly params: TParams) {
        this.logger = logger.child({ name: this.constructor.name, ...params });
    }

    /** Applies the test suite change to the snapshot draft. */
    abstract apply(params: ApplyChangeParams): Promise<TResult>;
}
