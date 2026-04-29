import type { LanguageModel } from "ai";
import type { FlowIndex } from "../flow-index";
import type { ScenarioIndex } from "../scenario-index";
import type { TestDirectory } from "../test-directory";
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
import { buildQuarantineTestTool } from "./quarantine-test-tool";
import { buildReadFileTool } from "./read-file-tool";
import { buildReadScenarioTool } from "./read-scenario-tool";
import { buildReadSkillTool } from "./read-skill-tool";
import { buildReadTestTool } from "./read-test-tool";
import { buildReportBugTool } from "./report-bug-tool";
import type { ResolutionResultCollector } from "./resolution-finish-tool";
import { buildSubagentTool } from "./subagent-tool";
import { buildSuggestTestTool } from "./suggest-test-tool";

export function buildCodebaseTools(model: LanguageModel, workingDirectory: string) {
    return {
        bash: buildBashTool(workingDirectory),
        glob: buildGlobTool(workingDirectory),
        grep: buildGrepTool(workingDirectory),
        read_file: buildReadFileTool(workingDirectory),
        subagent: buildSubagentTool(model, workingDirectory),
    };
}

export function buildActionTools(collector: ResultCollector, validSlugs: Set<string>, validConflictSlugs: Set<string>) {
    return {
        mark_affected_test: buildMarkAffectedTestTool(collector, validSlugs),
        explain_merge_conflict: buildExplainMergeConflictTool(collector, validConflictSlugs),
        suggest_test: buildSuggestTestTool(collector),
    };
}

export function buildTestInteractionTools(flowIndex: FlowIndex, testDirectory: TestDirectory) {
    return {
        list_flows: buildListFlowsTool(flowIndex),
        list_tests: buildListTestsTool(flowIndex, testDirectory),
        read_test: buildReadTestTool(testDirectory),
        read_skill: buildReadSkillTool(testDirectory),
    };
}

export function buildResolutionActionTools(
    collector: ResolutionResultCollector,
    validSlugs: Set<string>,
    flowIndex: FlowIndex,
    scenarioIndex: ScenarioIndex,
) {
    return {
        modify_test: buildModifyTestTool(collector, validSlugs),
        quarantine_test: buildQuarantineTestTool(collector, validSlugs),
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
