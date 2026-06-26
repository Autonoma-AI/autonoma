/**
 * Build the scaffolded `expected.md` for a freshly captured Healing case
 * (`skip: true`, with the deterministic checks commented out for the author to
 * fill in). Shared by both the iteration-based capture and the snapshot-based
 * first-turn capture.
 *
 * `sourceLabel` describes where the case was captured from (e.g.
 * `iteration <id>` or `snapshot <id>`).
 */
export function buildHealingExpected(
    sourceLabel: string,
    failures: { testCaseId: string; testCaseSlug: string }[],
): string {
    const expectedLines = failures.map(
        (f) =>
            `#   ${f.testCaseId}: update_plan   # ${f.testCaseSlug} - pick: update_plan | report_bug | report_engine_limitation | report_unknown_issue | remove_test`,
    );
    const expectedBlock =
        expectedLines.length > 0 ? expectedLines.join("\n") : "#   (no failing test cases in this turn)";

    const provenanceLines = failures.map(
        (f) =>
            `#   ${f.testCaseId}: quarantined   # ${f.testCaseSlug} - removed (invalid new test) | quarantined (pre-existing)`,
    );
    const provenanceBlock =
        provenanceLines.length > 0 ? provenanceLines.join("\n") : "#   (no failing test cases in this turn)";

    return `---
description: "Captured from ${sourceLabel} - TODO: describe what this case exercises"
skip: true
# Deterministic checks (uncomment + fill in, then set skip: false).
#
# expectedActions: pins the exact action kind for the failing test cases whose
# action kind matters. You may leave entries commented out and cover them in the
# judge rubric instead; every uncommented key must be in input.json failures.
# expectedActions:
${expectedBlock}
#
# provenance: grades the remove-vs-quarantine rule. Keys are a subset of the
# failing test cases (only those whose disposition matters). Use \`removed\` for an
# invalid test authored this snapshot (must be remove_test, and its failure must
# carry a reviewLink) and \`quarantined\` for a pre-existing failing test (must NOT
# be removed - any of update_plan / report_bug / report_engine_limitation /
# report_unknown_issue).
# provenance:
${provenanceBlock}
---

TODO: author the LLM-judge rubric here.

The judge sees only the agent's structured output plus this body - never the
codebase or screenshots. Grade qualities the deterministic checks cannot express:
  - For each \`update_plan\`: does the \`newPrompt\` address the cited failure?
    Is it specific enough? Does it preserve the test's original intent?
  - For each \`report_bug\` / \`report_engine_limitation\` / \`report_unknown_issue\`: is the
    triage correct (grounded application defect vs. engine/agent limitation vs. a suspected
    bug that couldn't be grounded in code)? For \`report_bug\`, is the \`suspectedCause\`
    genuinely grounded? Are the description and severity proportionate to the cited reasoning?
  - For each \`remove_test\`: is the cited reason plausible given the failure
    context - i.e. an invalid test born this snapshot or a feature removed from
    the app, not a pre-existing test that merely fails?
Keep every point additive to the frontmatter, and phrase each as something
checkable from the structured output alone.
`;
}
