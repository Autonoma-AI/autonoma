import type { LanguageModel } from "ai";
import type { DiffsAgentCallbacks } from "../callbacks";
import { buildAddTestTool } from "./add-test-tool";
import { buildBashTool } from "./bash-tool";
import { buildBugFoundTool } from "./bug-found-tool";
import type { ResultCollector } from "./finish-tool";
import { buildGlobTool } from "./glob-tool";
import { buildGrepTool } from "./grep-tool";
import { buildModifyTestTool } from "./modify-test-tool";
import { buildQuarantineTestTool } from "./quarantine-test-tool";
import { buildReadFileTool } from "./read-file-tool";
import { buildRunTestTool } from "./run-test-tool";
import { buildSubagentTool } from "./subagent-tool";
import { buildUpdateSkillTool } from "./update-skill-tool";

export function buildCodebaseTools(model: LanguageModel, workingDirectory: string) {
    return {
        bash: buildBashTool(workingDirectory),
        glob: buildGlobTool(workingDirectory),
        grep: buildGrepTool(workingDirectory),
        read_file: buildReadFileTool(workingDirectory),
        subagent: buildSubagentTool(model, workingDirectory),
    };
}

export function buildActionTools(
    callbacks: DiffsAgentCallbacks,
    completedRuns: Set<string>,
    collector: ResultCollector,
    validSlugs: Set<string>,
) {
    return {
        run_test: buildRunTestTool(callbacks, completedRuns, validSlugs),
        quarantine_test: buildQuarantineTestTool(callbacks, completedRuns, collector),
        bug_found: buildBugFoundTool(callbacks, completedRuns, collector),
        modify_test: buildModifyTestTool(callbacks, completedRuns, collector),
        update_skill: buildUpdateSkillTool(callbacks, collector),
        add_test: buildAddTestTool({
            add: (test) => collector.newTests.push(test),
        }),
    };
}
