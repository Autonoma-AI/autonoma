import type { LanguageModel } from "ai";
import type { ExistingTestInfo } from "../diffs-agent";
import type { FlowIndex } from "../flow-index";
import type { ScenarioIndex } from "../scenario-index";
import { buildAddTestTool } from "./add-test-tool";
import { buildBashTool } from "./bash-tool";
import { buildExplainMergeConflictTool } from "./explain-merge-conflict-tool";
import type { ResultCollector } from "./finish-tool";
import { buildGlobTool } from "./glob-tool";
import { buildGrepTool } from "./grep-tool";
import { buildListFlowsTool } from "./list-flows-tool";
import { buildListScenariosTool } from "./list-scenarios-tool";
import { buildListTestsTool } from "./list-tests-tool";
import { buildMarkAffectedTestTool } from "./mark-affected-test-tool";
import { buildModifyTestTool } from "./modify-test-tool";
import { buildReadFileTool } from "./read-file-tool";
import { buildReadScenarioTool } from "./read-scenario-tool";
import { buildReadTestTool } from "./read-test-tool";
import { buildRemoveTestTool } from "./remove-test-tool";
import { buildReportBugTool } from "./report-bug-tool";
import type { ResolutionResultCollector } from "./resolution-finish-tool";
import { buildSubagentTool } from "./subagent-tool";
import { buildSuggestTestTool } from "./suggest-test-tool";

export function buildCodebaseTools(model: LanguageModel, workingDirectory: string) {
    return {
        bash: buildBashTool(workingDirectory),
        glob: buildGlobTool(workingDirectory),
        grep: buildGrepTool(workingDirectory),
        read_files: buildReadFileTool(workingDirectory),
        subagent: buildSubagentTool(model, workingDirectory),
    };
}

export function buildActionTools(
    collector: ResultCollector,
    validSlugs: Set<string>,
    validConflictSlugs: Set<string>,
    quarantinedSlugs: Set<string>,
) {
    return {
        mark_affected_test: buildMarkAffectedTestTool(collector, validSlugs, quarantinedSlugs),
        explain_merge_conflict: buildExplainMergeConflictTool(collector, validConflictSlugs),
        suggest_test: buildSuggestTestTool(collector),
    };
}

export function buildTestInteractionTools(flowIndex: FlowIndex, tests: ExistingTestInfo[]) {
    return {
        list_flows: buildListFlowsTool(flowIndex),
        list_tests: buildListTestsTool(flowIndex, tests),
        read_tests: buildReadTestTool(tests),
    };
}

export function buildResolutionActionTools(
    collector: ResolutionResultCollector,
    validSlugs: Set<string>,
    quarantinedSlugs: Set<string>,
    flowIndex: FlowIndex,
    scenarioIndex: ScenarioIndex,
) {
    return {
        modify_test: buildModifyTestTool(collector, validSlugs, quarantinedSlugs),
        remove_test: buildRemoveTestTool(collector, validSlugs),
        report_bug: buildReportBugTool(collector),
        add_test: buildAddTestTool(collector, flowIndex, scenarioIndex),
    };
}

export function buildScenarioTools(scenarioIndex: ScenarioIndex) {
    return {
        list_scenarios: buildListScenariosTool(scenarioIndex),
        read_scenario: buildReadScenarioTool(scenarioIndex),
    };
}
