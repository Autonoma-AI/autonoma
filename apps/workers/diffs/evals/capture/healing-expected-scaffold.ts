/**
 * Build the scaffolded `expected.md` for a freshly captured Healing case
 * (`skip: true`, with the deterministic checks commented out for the author to
 * fill in). Shared by both the iteration-based capture and the snapshot-based
 * first-turn capture.
 *
 * `sourceLabel` describes where the case was captured from (e.g.
 * `iteration <id>` or `snapshot <id>`). The candidate-channel scaffold is
 * emitted only when the captured turn carried candidates (the folded-resolution
 * first turn).
 */
export function buildHealingExpected(
    sourceLabel: string,
    failures: { testCaseId: string; testCaseSlug: string }[],
    candidates: { candidateId: string; name: string }[],
): string {
    const expectedLines = failures.map(
        (f) =>
            `#   ${f.testCaseId}: update_plan   # ${f.testCaseSlug} - pick: update_plan | report_bug | report_engine_limitation | remove_test`,
    );
    const expectedBlock =
        expectedLines.length > 0 ? expectedLines.join("\n") : "#   (no failing test cases in this turn)";

    return `---
description: "Captured from ${sourceLabel} - TODO: describe what this case exercises"
skip: true
# Deterministic check (uncomment + fill in, then set skip: false).
# One entry per failing test case in input.json; the keyset must match exactly,
# and each value is the action kind that test case should receive.
# expectedActions:
${expectedBlock}
${candidateBlock(candidates)}---

TODO: author the LLM-judge rubric here.

The judge sees only the agent's structured output plus this body - never the
codebase or screenshots. Grade qualities the deterministic check cannot express:
  - For each \`update_plan\`: does the \`newPrompt\` address the cited failure?
    Is it specific enough? Does it preserve the test's original intent?
  - For each \`report_bug\` / \`report_engine_limitation\`: is the triage correct
    (application defect vs. engine/agent limitation)? Are the description and
    severity proportionate to the cited reasoning?
  - For each \`remove_test\`: is the cited reason plausible given the failure
    context (e.g. feature removed from the app)?
${candidateRubric(candidates)}Keep every point additive to the frontmatter, and phrase each as something
checkable from the structured output alone.
`;
}

/**
 * The candidate-channel deterministic-check scaffold, emitted only when the
 * captured turn carried first-turn candidates (the folded resolution turn).
 * Lists each candidate id so the author can pin which to accept / reject.
 */
function candidateBlock(candidates: { candidateId: string; name: string }[]): string {
    if (candidates.length === 0) return "";

    const ids = candidates.map((c) => `#   - ${c.candidateId}   # ${c.name}`).join("\n");
    return `# Candidate channel (first-turn / folded resolution). Uncomment what applies.
# newTests:           # inclusive bounds on how many new tests the agent adds
#   minCount: 0
#   maxCount: 0
# acceptsCandidate:   # candidate ids the agent MUST accept via add_test
${ids}
# rejectsCandidate:   # candidate ids the agent MUST reject
${ids}
`;
}

/** Judge-rubric hints for the candidate channel, emitted only when candidates were captured. */
function candidateRubric(candidates: { candidateId: string; name: string }[]): string {
    if (candidates.length === 0) return "";

    return `  - For each accepted candidate (\`add_test\`): is the new-test instruction clear,
    on-topic for the candidate, and placed in a sensible folder?
  - For each rejected candidate: is the rejection reasoning sound (e.g. duplicate
    coverage, out of scope) rather than a missed opportunity?
`;
}
