# Diffs pipeline evals

Local, per-step, **scored** evaluations for the diffs pipeline - the replacement for
the eyeball-only local-dev scripts. Each step keeps a corpus of on-disk cases and
scores the agent's output with **deterministic frontmatter checks plus an LLM judge**.

Two steps are currently under eval: **Diff Analysis** and the **Classifier** (the
Investigator's verdict on one run). The classifier eval additionally exercises the
**multimedia rehydration path** - it downloads screenshots + the recording from S3
at run time via the production evidence loader. No media bytes are ever committed.

Note that `analysis/` is the **impact-analysis** step (the `DiffsAgent`, which picks
which tests a diff affects), while `classifier/` is the step that judges what a run's
outcome MEANT. Both live under the pipeline's "analysis" banner; they grade different
agents.

Each step lives in its own subdirectory (`<step>/`) with the same four files
(`<step>-input.ts` schema, `<step>-frontmatter.ts` deterministic checks,
`<step>-evaluation.ts` Evaluation subclass, `<step>.eval.ts` vitest entry).
Step-agnostic primitives live in `framework/`; each step also has a
`capture-<step>.ts` library and a `capture-<step>-cli.ts` entry under `capture/`,
both wired through the package's `capture:<step>` scripts.

## Where the cases live

Cases are committed here, at `evals/cases/<step>/<name>/`, resolved from
`framework/cases-dir.ts`. Both the eval suites and the capture commands read the
same in-tree path, so a corpus change and the harness change that needs it land
in one commit.

A captured case carries client data - test-plan prompts, plan/scenario content
(including fixtures that may hold seeded credentials), client repo owner/name, S3
keys, and model conversations - so the whole `evals/cases/` root is stripped from
the public mirror by `.opensource-ignore`, the same way the planner corpus under
`apps/cli/evals/cases/` is. Every step's cases sit under that one root so the
strip rule is a single directory rather than a glob per step. The harness around
it stays public; a step with no cases on disk (in the mirror, or before its first
capture) resolves **zero cases and no-ops** rather than failing, so external
contributors are never broken.

## The eval-case contract

Each case is a folder under `evals/cases/<step>/<name>/`:

- **`input.json`** - the **frozen, assembled `XxxAgentInput`**, snapshotted at capture time so
  eval runs need no database. The codebase is stored as coordinates
  `{ owner, repo, installationId, baseSha, headSha }`; the `FlowIndex` / `ScenarioIndex` are
  stored as their underlying arrays and reconstructed at load. Anything that is a pure
  function of those coords is **not** frozen - the classifier's diff stat is read at run
  time through the same `readPrDiffStat` production calls, since a frozen copy could only
  go stale against that helper.
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
createdTests:                              # dedup guardrail for tests authored via create_test
  count: { minCount: 0, maxCount: 1 }      #   how many new tests (maxCount: 0 = diff fully covered)
  folders:                                 #   which flow folders the new tests land in
    exclude: [Checkout]                    #     nothing new may be authored into an already-covered folder
    include: [Auth]                        #     a new test MUST land here
---

Free-text judge rubric. The judge sees only the agent's structured output plus this
body - never the codebase or screenshots. Write it ADDITIVE to the frontmatter: grade
qualities the deterministic checks cannot (sound reasoning; whether each `create_test`
proposal is genuinely non-redundant vs. the named existing tests; whether its
coverage justification soundly explains why those tests do not already cover it).
```

The diffs agent authors tests directly via `create_test`, and nothing culls a
passing-but-redundant test once it is created, so the analysis eval is the primary
automated guardrail against suite bloat. `createdTests` bounds the _shape_ of what
was authored (how many, into which folders), and every created test is checked for a
non-blank coverage justification; whether each test is _genuinely_ non-redundant and
its justification _sound_ is graded by the judge.

### Classifier frontmatter

A classifier case is **one `AnalysisClassification`** - a single classifier invocation.
That grain is what makes a self-heal re-run capturable on its own: iteration 2 of a
finding is its own row, with its own generation and its own `priorPass`, exercising a
prompt path iteration 1 never reaches. Rows with a **null confidence** are contained
faults where no classifier ran, and capture refuses them.

```yaml
---
description: "what this case exercises"
skip: false
capturedCategory: engine_artifact   # what production said when frozen. Provenance, never edited
category: passed                    # the verdict this case ASSERTS (blank at capture, by design)
planFidelity: exact                 # optional: exact | partial | diverged
expectRewrite: true                 # a plan_mismatch must carry a revised plan (see below)
runs: 1                             # >1 requires EVERY run to pass, which measures stability
---

Free-text judge rubric. The judge sees only the structured verdict plus this body -
never the codebase, recording, or screenshots.
```

`category` is deliberately **left blank by capture**: pre-filling it from production
would make ratifying a wrong verdict the path of least resistance. `capturedCategory`
records what production said, and is never edited - so when an expectation is later
re-baselined (an `engine_artifact` that should now read `passed` because the engine
grew the capability), the case still shows where it started.

Only `category`, `planFidelity` and a `plan_mismatch`'s `suggestedTestUpdate` are
graded deterministically. `confidence` is not - it is the field most likely to move
between two runs of an unchanged classifier. `evidence` and `keyStepIndex` are not
either: whether the cited evidence supports the verdict, and which frame best shows a
finding, are judgements the rubric exists for. Set `expectRewrite: false` for a case
whose right answer is the empty rewrite, which the self-heal loop reads as "keep this
test without re-running it" - a real answer a blanket requirement would train away.

**The vision probes run live, every time.** A case stores no scans: the agent reads the
recording itself on every run, exactly as production does. Each run therefore costs four
full-recording vision reads on top of the loop, and the probes are one of the places a
verdict moves between two runs of an unchanged classifier - which is what `runs: N` measures.

**What a replay cannot serve.** One of the classifier's live-infra capabilities has no
frozen form: the preview's live backend (`run_script`). A replay passes it as absent, and
the classifier is told so through its own evidence-limits note, so it caps unprovable
claims instead of guessing. Every case records in `productionCapabilities` the one fact all
those tools hung on - `previewkitManaged`, whether previewkit deployed the PR - so a case
captured from a preview-integrated run says outright when it is graded against a classifier
that could see more than this replay does. What the replay actually closes stays a per-tool
question, answered by which frozen data the case carries (`previewEnvNames`, `appLogs`), not
by that one fact.

`get_preview_env` and `get_app_logs` are the exceptions, and both ARE served in replay -
they are the capabilities that reduce to data. Listing the preview's
env-var names never reaches the running pod at call time - it is a name list plus a
local substring filter - so capture freezes the whole list into `previewEnvNames` and
replay narrows it through the same filter. That matters because an absent integration
key is how the classifier tells "the SDK never initialized, so what it gates fell back
to its code default" from a guess. A case carrying the list is not counted as missing
the tool; one without it still is. **The filter is exact, the list is a
reconstruction** - see [what capture recomputes](#capturing-a-case).

The two preview halves are separate capabilities on `ClassifierInput` (`previewEnv` and
`previewScript`), each gating its own tool. Backend reachability - what the
evidence-limits note calls "you CAN query its backend" - keys on the script capability
alone, so a replay holding only the name list is never told it can reach a backend it
cannot.

The log stream is the other one that reduces to data, and it is described below.

### The frozen app-log window

`get_app_logs` **is** served on replay, from a log window frozen at capture into
`input.json` as `appLogs`. The window is stored **unfiltered**: production interpolated
the model's own regex into a LogQL line filter and had Loki evaluate it server-side, so
the filter is not knowable at capture time - only the stream it would have run against.

- **Capture** freezes the whole padded run window over the same stream selector, through
  the same `queryLokiLogs`, and records `windowTruncated` when that query filled its own
  cap (Loki's `max_entries_limit_per_query`, 5000).
- **Replay** does what Loki did: apply the regex, keep the newest 150 matches, and set
  the truncation flag. The prose is **not** reimplemented - the frozen window is injected
  as the production loader's querier, so the namespace header, the per-line run offsets,
  the truncation warning and the "the app emitted no matching error, do NOT infer a
  backend error that is not present" fact are byte-identical to production's. One
  combination is new: zero matches over a window that was itself capped. A live query
  cannot produce it (its truncation flag *is* a full page of matches), and the loader now
  qualifies the fact there rather than stating a window it only partly searched was quiet.
- **The filter runs through an RE2 engine, not a translation.** Loki evaluates the line
  filter with Go's `regexp`, whose language is RE2 - a _different language_ from JS
  `RegExp`, which rejects inline flag groups (`(?i:x)`, and a mid-pattern `(?i)`), reads
  `\p{...}` and `\x{...}` as literal text, and accepts the lookaround and backreferences
  RE2 rejects. Replay therefore filters with `re2js`, a pure-JS port of RE2: same language,
  so any pattern both accept selects the same lines with nothing to prove. A pattern RE2
  rejects throws, which the tool renders as "could not read the app logs" - the same
  outcome the pattern had in production, where Loki answered it with an HTTP 400.
- **One pattern class still diverges**, and in the direction of replay seeing more. Loki's
  own line-filter simplifier mis-evaluates `<literal>.*(a|b)` when the literal occurs again
  after the alternation's match: measured live, `mongo.*down` matched a line that
  `mongo.*(fail|down)` did not (that line carries `mongo` at offsets 116 and 912, `down` at
  200). A real RE2 engine matches it, so this is Loki's bug and not an artefact of where the
  pattern is evaluated. Not emulated - the emulation would have to be removed when it is
  fixed. The default filter is a bare alternation with no `.*`, and is unaffected.

**Capture refuses rather than freezing a window it could not read.** An empty window is
stated to the model as the fact "the app emitted no matching error", so a window that came
back empty because Loki was unreachable, or because the run aged out of retention, would
bake a fabricated "the app was quiet" into the case permanently. Loki answers an aged-out
query with HTTP 200 and zero streams (`max_query_lookback: 0s`), so the age check is the
harness's to make: capture refuses a run older than the instance's 31-day retention less a
24h margin. `--skip-app-logs` gives the window up deliberately - the escape hatch for a
run that has aged out, or a machine that cannot reach Loki - and the case then records
`get_app_logs` as a production-only tool.

A window that was genuinely queried and genuinely empty **is** frozen; that is a real and
common production answer. Capture warns about it, and checks the wider window either side
of the run: a namespace that carried no app line for hours never had its logs shipped at
all, and its emptiness is then no evidence the app was healthy. Worth knowing before
authoring an expectation on it, because the loader's prose invites exactly that inference.

### Multimedia rehydration

The classifier eval downloads every step screenshot + the run video from
S3 at agent run time via the production `StorageEvidenceLoader` - the same loader
production uses. Before the agent starts the harness calls
`probeEvidence(...)` to walk every referenced key and surface a typed
`MissingEvidenceError` if any key has been rotated away. A case in that state
skips with a warning the same way an unfetchable SHA does.

Captured `input.json` files store media as **S3 keys**, never bytes.

The classifier stores the recording key alongside an `isOptimizedMp4` flag, because the
uploader has to be told a mime type and the key alone does not say: production reads the
dead-time-stripped mp4 when the optimizer produced one and the original webm otherwise.
Its recording is re-uploaded **per run**, not once per case - an uploaded video is a
handle with its own lifetime at the provider, so a `runs: N` case would otherwise replay
a handle that may have expired mid-sweep.

## Running the evals

Evals are gated behind `RUN_EVALS` and need real model credentials (`GEMINI_API_KEY`,
`GROQ_KEY`, `OPENROUTER_API_KEY`) plus `git` and `rg` on PATH. Cases against a private client
repo also need the `GITHUB_APP_*` credentials to mint a clone token; public-repo cases and cases
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

Each per-step eval has its own capture command. Both resolve the case's git
coordinates, **validate both SHAs are fetchable** (refusing to write a case with a
dead SHA), and freeze the production loader's output to disk. Both read the DB;
eval runs never touch it.

Capture writes the case to `evals/cases/<step>/<name>/`, alongside the ones already
committed.

`capture:classifier` additionally needs `LOKI_URL` for a previewkit-managed PR, whose
app-log window it freezes (see [The frozen app-log
window](#the-frozen-app-log-window)); Loki is reachable over Tailscale. A run whose logs
have aged out, or a machine that cannot reach Loki, needs `--skip-app-logs` to capture at
all - the default is to refuse rather than freeze a window nobody could read.

```bash
pnpm --filter @autonoma/worker-diffs capture:analysis               <snapshotId>   [--name <case-name>] [--force]
pnpm --filter @autonoma/worker-diffs capture:classifier            <classificationId> [--name <case-name>] [--force] [--skip-app-logs]
```

After capture, fill in the frontmatter checks and the rubric
in `expected.md`, then flip `skip: false`.

`--force` **re-freezes an existing case's `input.json`** - use it to pull a case forward when the
frozen shape gains a field. It never touches `expected.md`: the expectation is hand-authored, so
only a case that does not have one yet gets the blank template.

**Classifier - what capture recomputes.** Everything the classifier reasons from is
reassembled through the **same helpers the production activity uses** (the generation
select, `buildRunFacts`, `describeProvision`, the PR metadata), so a
frozen case cannot quietly diverge from what production classified. Two things are
recomputed rather than read back, and **both are bounded to the classification's own
`createdAt`**, because the source behind each is mutable and a capture typically runs
weeks after the classification it freezes:

- **The prior-runs baseline** - the verdicts earlier analyses reached on this test.
  Without that bound, runs analyzed *after* the classification leak into `everPassed` and
  `mostRecentPassDay` - the line deciding whether the classifier may blame the PR at all -
  handing a replay a baseline the original could never have seen.
- **The preview's env-var names**, read through the same `PreviewEnvironment` production
  reads: the app's secret bundle unioned with the connection keys the PR's deployed
  config wires in. Unbounded, it would hand the replay a key that did not exist when
  production answered ABSENT.

  Capture **refuses to freeze a partial list** - it warns and writes no `previewEnvNames`
  at all - when `resolved_config` is gone (wiped after ~60 days) or unparseable, when the
  secret read fails, or when the bound excludes the **whole** secret bundle. That last one
  is not hypothetical: `previewkit_secret` rows were bulk-written when preview secrets
  moved into postgres (2026-07-30), so every classification older than that migration
  would otherwise freeze the connection keys alone - a list asserting every secret was
  absent. A case without the list simply has no `get_preview_env`.

  The bound cannot cover a key **deleted** since, so the list may still understate what
  production read; capture warns when it detects additions, which is the nearest signal
  that a bundle is being edited at all. Treat it as a prompt to pick a different
  classification. `resolved_config` is read live too, and is rewritten on each deploy.

Classifier capture needs no model credentials and never downloads media: it takes the
run's facts (`buildRunFacts`, which does no I/O) and writes the recording and final frame
as storage keys for the evaluation to fetch. It does need `PREVIEWKIT_SECRETS_CMK` to
read the env-var names; without it the case is still written, minus `get_preview_env`.

**Baseline snapshot state (Analysis).** Analysis grades against the snapshot as it stood _before_
this snapshot's pipeline ran. At production time the snapshot's own assignments are still that
baseline (analysis does not write to the suite), so the runner reads them directly. Capture,
however, runs _after_ the pipeline has rewritten those assignments, so it loads the baseline from
the snapshot's **previous** snapshot - the unmutated copy - to reproduce exactly what the step saw.
This is controlled by the `testSuiteSource` option on the shared `assembleDiffsAgentInput` loader
(`"current"` for the runner, `"previous"` for capture).

**Live application-level reads (Analysis).** A few fields are not snapshot-scoped and
are read live from the application at capture time:

- `testScopeGuidelines` - free-text guidelines on the `Application` row. If the
  owner edits them between capture and eval run, the captured value will diverge from what
  production saw at the time.
- `scenarios` - the application's enabled scenarios, exposed so `create_test` can bind a
  `scenarioId`. Scenarios are referenced by id, so if one is deleted between capture and eval
  run the frozen ids become stale.
- `folder list + names/descriptions` (via `loadFlows`) - the per-folder _test slugs_ are
  snapshot-scoped, but the folder metadata itself is read live. Folders cannot currently be
  product-edited, so this rarely drifts.

A capture against a freshly-finished snapshot is always faithful; an older snapshot may pick up
these drifts. Treat them the same way you treat flow / test ids in analysis cases: stable enough
in practice, but a re-capture is the fix if an eval starts drifting for reasons unrelated to the
agent.
