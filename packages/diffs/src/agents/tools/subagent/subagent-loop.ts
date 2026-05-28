import { type AgentConfig, AgentLoop } from "@autonoma/ai";
import type { Codebase } from "../../../codebase";
import type { CodebaseLoop } from "../codebase/codebase-loop";

export interface SubagentResult {
    findings: string;
}

interface SubagentLoopParams extends AgentConfig<SubagentResult> {
    codebase: Codebase;
}

/** Per-run state for the research subagent. Holds the parent agent's codebase. */
export class SubagentLoop extends AgentLoop<SubagentResult> implements CodebaseLoop {
    public readonly codebase: Codebase;

    constructor({ codebase, ...config }: SubagentLoopParams) {
        super(config);
        this.codebase = codebase;
    }
}
