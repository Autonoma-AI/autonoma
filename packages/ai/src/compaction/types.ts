import type { ModelMessage } from "ai";

export interface CompactionResult {
    readonly messages: ModelMessage[];
    readonly messagesAffected: number;
}

export interface MessageCompactor {
    /** Used as the `strategy` field on compaction observability events. */
    readonly name: string;
    compact(messages: ModelMessage[]): Promise<CompactionResult>;
}
