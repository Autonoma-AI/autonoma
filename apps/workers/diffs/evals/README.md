# Diffs pipeline evals

Local, per-step, **scored** evaluations for the diffs pipeline - the replacement for
the eyeball-only local-dev scripts. Each step keeps a corpus of on-disk cases and
scores the agent's output with **deterministic frontmatter checks plus an LLM judge**.

Five steps are currently under eval: **Diff Analysis**, **Diff Resolution**,
**Generation Review**, **Replay Review**, and **Diff Healing**. The reviewer evals
additionally exercise the **multimedia rehydration path** - they download
screenshots + the recording from S3 at run time via the production evidence loader.
No media bytes are ever committed.

Each step lives in its own subdirectory (`<step>/`) with the same four files
(`<step>-input.ts` schema, `<step>-frontmatter.ts` deterministic checks,
`<step>-evaluation.ts` Evaluation subclass, `<step>.eval.ts` vitest entry) plus a
`cases/<name>/` folder per case. Step-agnostic primitives live in `framework/`;
each step also has a `capture-<step>.ts` library and a `capture-<step>-cli.ts`
entry under `capture/`, both wired through the package's `capture:<step>` scripts.

## The eval-case contract

Each case is a folder under `<step>/cases/<name>/`:

- **`input.json`** - the **frozen, assembled `XxxAgentInput`**, snapshotted at capture time so
  eval runs need no database. The codebase is stored as coordinates
  `{ owner, repo, installationId, baseSha, headSha }`; the `FlowIndex` / `ScenarioIndex` are
  stored as their underlying arrays and reconstructed at load.
- **`expected.md`** - YAML frontmatter holds the **deterministic checks**; the body holds the
  **LLM-judge rubric**. A case passes iff **all frontmatter checks pass AND the judge passes**.

### Analysis frontmatter

```yaml
---
description: "what this case exercises"   # optional, ignored by checks
skip: false                                # when true, the case is loaded but not run
affected:                                  # checks over the affected-test slug set
  include: [slug-a]                        #   must be present
  exclude: [slug-b]                        #   must be absent
  exact: [slug-a, slug-c]                  #   the exact set (order-insensitive)
candidates:                                # bounds on the new-test-candidate count
  minCount: 1
  maxCount: 3
---

Free-text judge rubric. The judge sees only the agent's structured output plus this
body - never the codebase or screenshots. Write it ADDITIVE to the frontmatter: grade
qualities the deterministic checks cannot (sound reasoning, sensible candidates).
```

### Resolution frontmatter

```yaml
---
description: "what this case exercises"
skip: false
modified:                                  # set check over modifiedTests[].slug
  include: [slug-a]
  exclude: [slug-b]
  exact: [slug-a, slug-c]
removed:                                   # set check over removedTests[].slug
  include: []
  exclude: []
  exact: []
newTests:                                  # bounds on newTests.length
  minCount: 1
  maxCount: 3
reportedBugs:                              # bounds on reportedBugs.length
  minCount: 0
  maxCount: 2
acceptsCandidate: [candidate-id-x]         # each id MUST appear in some newTests[].acceptingCandidateId
---

Judge rubric: grade qualities the deterministic checks cannot - e.g. new-test instruction quality,
modification correctness, and bug-report accuracy.
```

### Reviewer frontmatter (generation + replay)

Both reviewer evals share the same shape. Only `verdict` is graded
deterministically - the reviewer also emits `severity` / `confidence` but
production drops both (see #783), so asserting on them would gate on dead
fields. The verdict enum differs per reviewer:
`success | agent_limitation | application_bug | plan_mismatch` for generation,
`engine_error | application_bug` for replay.

```yaml
---
description: "what this case exercises"
skip: false
verdict: application_bug      # enum-equality (per-reviewer enum)
---

Free-text judge rubric. The judge sees only the reviewer's structured verdict plus
this body - never the codebase, conversation, screenshots, or video. Grade qualities
the deterministic verdict check cannot: does the reasoning cite the actual failure
point, no hallucinated steps, correct engine-vs-app attribution?
```

### Healing frontmatter

```yaml
---
description: "what this case exercises"
skip: false
expectedActions: # one entry per failing test case in input.json
    tc-abc: update_plan # the kind the agent must emit for this test case
    tc-def: report_bug
    tc-ghi: remove_test
---
Free-text judge rubric. Grade qualities the deterministic check cannot:
    - For each update_plan: does the newPrompt actually address the cited failure?
    - For each report_bug / report_engine_limitation: is the triage correct?
    - For each remove_test: is the cited reason plausible given the failure context?
```

Healing's runtime invariant is that every input failure is handled by exactly one
action (the agent loop throws otherwise). The eval mirrors that: the `expectedActions`
keyset must equal the set of `failures[].testCaseId` in `input.json`. A partial or
mismatched map throws at load time rather than at run time.

### Multimedia rehydration

The reviewer evals download every step screenshot + the run video from S3 at
agent run time via the production `StorageEvidenceLoader` - the same loader the
production reviewer uses. Before the agent starts the harness calls
`probeEvidence(...)` to walk every referenced key and surface a typed
`MissingEvidenceError` if any key has been rotated away. A case in that state
skips with a warning the same way an unfetchable SHA does.

Captured `input.json` files store media as **S3 keys**, never bytes. Generation
review additionally stores the agent conversation, with image parts stripped at
capture time via `sanitizeConversation` so the fixture stays text-only.

## Running the evals

Evals are gated behind `RUN_EVALS` and need real model credentials
(`GEMINI_API_KEY`, `GROQ_KEY`, `OPENROUTER_API_KEY`) plus `git` and `rg` on PATH. Private-repo
cases also need the `GITHUB_APP_*` credentials to mint a clone token; public-repo cases and cases
whose commits are already in the repo cache run without them.

```bash
pnpm --filter @autonoma/worker-diffs eval
```

- The suite runs **sequentially** - every case shares one on-disk working tree in the gitignored
  repo cache (`evals/.cache/repos/`), so concurrent checkouts are impossible.
- A case whose `baseSha`/`headSha` can no longer be fetched **skips with a warning** rather than
  red-failing the suite.
- A JSON result with a pass-rate is written to `<step>/results/` (gitignored).

## Capturing a case

Each per-step eval has its own capture command. They all resolve the relevant
snapshot's (or iteration's) git coordinates, **validate both SHAs are fetchable**
(refusing to write a case with a dead SHA), and freeze the production loader's output
to disk. The reviewer captures additionally **probe every referenced S3 key** with the
production evidence loader so a media-rotated fixture is never written. All capture
commands read the DB; eval runs never touch it.

```bash
pnpm --filter @autonoma/worker-diffs capture:analysis           <snapshotId>   [--name <case-name>] [--force]
pnpm --filter @autonoma/worker-diffs capture:resolution         <snapshotId>   [--name <case-name>] [--force]
pnpm --filter @autonoma/worker-diffs capture:generation-review  <generationId> [--name <case-name>] [--force]
pnpm --filter @autonoma/worker-diffs capture:replay-review      <runId>        [--name <case-name>] [--force]
pnpm --filter @autonoma/worker-diffs capture:healing            <iterationId>  [--name <case-name>] [--force]
```

(Replay review is failure-only - it refuses runs whose status is not `"failed"`,
mirroring production.) After capture, fill in the frontmatter checks and the rubric
in `expected.md`, then flip `skip: false`.

**Baseline snapshot state (Analysis + Resolution).** Both steps grade against the snapshot as it
stood _before_ this snapshot's pipeline ran. At production time the snapshot's own assignments
are still that baseline (analysis does not write to the suite; resolution reads it once at the
start, before its own callbacks mutate it), so the runner reads them directly. Capture, however,
runs _after_ the pipeline has rewritten those assignments, so it loads the baseline from the
snapshot's **previous** snapshot - the unmutated copy - to reproduce exactly what the step saw.
This is controlled by the `testSuiteSource` option on the shared `assembleDiffsAgentInput` /
`assembleResolutionAgentInput` loaders (`"current"` for the runner, `"previous"` for capture).
For resolution the switch covers two fields: `existingTests` (the suite) and the quarantine flag
that `buildVerdicts` uses to filter out runs - both must travel together, otherwise capture would
silently drop the verdicts that resolution itself quarantined via `reportBug`.

**Test candidates (resolution only).** At production resolution time candidates carry
`status: "pending"`; afterwards they become `"accepted"` or `"rejected"`. The shared loader reads
candidates regardless of status so capture recovers the same input shape the agent saw - the
candidate `id`/`name`/`instruction`/`reasoning` fields are immutable.

**Healing - bucketing.** Healing capture re-buckets the iteration's plan outcomes via the shared
`bucketIterationOutcomes` helper (the same code the `analyzeResults` activity uses at production
time). Those reads only touch rows that the rest of the pipeline never mutates by id
(`TestGeneration`, `Run`, their reviews; `update_plan` creates a _new_ `TestPlan` rather than
mutating the existing one, so iter-N+1's generations are keyed by a different `planId` and
filtered out). The bucketing reproduces exactly.

**Live reads at capture (Reviewers).** Most reviewer inputs are immutable historic records
(conversation, steps, screenshots, video, the codebase clone, the agent's `reasoning`) or
schema-snapshotted at run/generation creation time (`run.plan` via `run.planId` -
`assignment.plan` is _not_ used, because `updatePlan` re-points the assignment to a new TestPlan
row). The remaining fields that capture re-reads live and can in principle drift between capture
and what production saw:

- **`testGeneration.status`** (the agent's self-reported status, surfaced as
  `selfReportedStatus`). The pipeline's `markAsFailed` path can retroactively set a stuck
  `pending` / `queued` generation to `failed`. Production reviews fire immediately so see the
  original status; capture later may see the mutated one. The reviewer treats this as a hint
  only, so it rarely changes the verdict.
- **`testCase.name`** (the human-readable test name). Mutable via test renames - the captured
  name may not match what the run originally executed. Doesn't influence the verdict; just a
  display string.

**Live application-level reads (Analysis + Resolution + Healing).** A few fields are not
snapshot-scoped and are read live from the application at capture time:

- `testScopeGuidelines` (all three steps) - free-text guidelines on the `Application` row. If the
  owner edits them between capture and eval run, the captured value will diverge from what
  production saw at the time.
- `scenarioIndex` (resolution + healing) - the application's enabled scenarios. Scenarios are
  referenced by id, so if one is deleted between capture and eval run the frozen ids become stale.
- `folder list + names/descriptions` (analysis + healing, via `loadFlows` / the healing
  `planAuthoring` block) - the per-folder _test slugs_ are snapshot-scoped, but the folder
  metadata itself is read live. Folders cannot currently be product-edited, so this rarely drifts.

A capture against a freshly-finished snapshot is always faithful; an older snapshot may pick up
these drifts. Treat them the same way you treat flow / test ids in analysis cases: stable enough
in practice, but a re-capture is the fix if an eval starts drifting for reasons unrelated to the
agent.
