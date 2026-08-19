# Suite health

A five-state signal, shown in the app sidebar, that answers one question: **how much should you trust
a failure this suite reports?**

The suite is written by an agent that has only read the code. It has never operated the app. Some of
what it wrote is wrong, and it only finds out by running against real pull requests. Suite health is
how we say that out loud, and how we show it getting better.

```
5  PROVEN       Every failure here is worth reading. False alarms are rare at this level.
4  STEADY       Tests are holding across PRs and the agent is healing drift on its own.
3  CALIBRATING  New suite. Written from your app, not yet proven against it. Expect some noise.   <- default
2  AT RISK      More tests are flaking than passing. A few decisions from you will fix this.
1  DEGRADED     Failures are piling up unresolved. The agent has stopped trusting its own tests.
```

Every new app starts at CALIBRATING (3/5). Not at zero, not at green.

---

## 1. The window

The sample is the **last 20 analysis runs that produced at least one finding**, no older than 30 days.

- A run is one `AnalysisJob` / `BranchSnapshot`. Both PR-branch runs and main-branch runs count.
- A completed run that selected no tests (0 findings) is **excluded entirely**. It is neither good
  nor bad, and counting it either way is a lie.
- A run counts once no matter how many tests it investigated, but findings pool across the window
  (see 2). 20 runs is enough that one 40-test PR cannot swing the number on its own.
- Fewer than 20 runs available: use what exists. The evidence gates in 4 handle the small-sample case.

Why runs and not calendar days: a busy app produces 100 runs in a week and a quiet one produces 3 in
a month. A fixed day window makes the first app's number twitchy and the second app's number
meaningless. A fixed run window gives both a comparable sample.

## 2. The base score: trust rate

```
trust = (passed + client_bug) / all findings in window
```

That is it. `passed` and `client_bug` are exactly the app-health plane of `AnalysisVerdict` - the two
verdicts that tell you something true about your application. Everything else
(`environment_failure`, `scenario_issue`, `engine_artifact`, `plan_mismatch`, `invalid_test`) is a
run that told you nothing, because the environment was down, the data was wrong, our harness
crashed, or the test itself was wrong about the app.

**A confirmed bug raises health, it does not lower it.** A suite that finds a real bug is a suite
doing its job. What lowers health is a run that cannot reach a verdict at all.

The base score is `100 x trust`.

## 3. Modifiers

Applied on top of the base, then clamped to 0-100. All are bounded so none can dominate.

| Modifier | Value | Source |
|---|---|---|
| Self-heal | `+8 x (saved / entered)`, only when `entered >= 5` | findings whose `currentClassification.number > 1`: `entered` = all of them, `saved` = those ending `passed` |
| Triage | +5 if >=1 issue resolved in window, +10 if >=3 | `AnalysisIssue.resolvedAt` set within the window (an issue's lifecycle IS its `resolvedAt`) |
| Pipeline failure | -15 x (failed jobs / total jobs) | `AnalysisJob.status = 'failed'` in the window, **excluding supersessions** |
| Staleness | -5 per open issue older than 7 days, cap -20 | `AnalysisIssue` where `resolvedAt IS NULL` and `created_at < now() - 7d`, on a branch whose PR is still open |

The pipeline-failure term exists because a run that dies produces no findings at all, so it is
invisible to the trust rate. Without it, an app whose analysis fails outright 40% of the time looks
identical to one where it always completes.

**`AnalysisJob.status = 'failed'` is not the same as "the pipeline failed."** In production, 252 of
254 failed jobs carry `failure_reason = 'Superseded by a newer analysis request'` - the run was
cancelled because the author pushed again. Counting those makes the modifier a push-frequency
penalty, which is exactly backwards: `agree-com/agree-web` had 30 such rows and was losing 4.4
points for shipping often. Only genuine terminal failures (timeout, clone failure, crash) count -
that is 2 rows across the entire fleet, so in practice this term is currently near zero for
everyone, and it is here to catch a regression rather than to separate today's apps.

The staleness term is the only thing in the model that is about the **user**, and it is the
mechanism behind DEGRADED: failures nobody triages accumulate and drag the score down even while new
runs keep passing.

**The self-heal term must be a rate, not a count.** A successfully healed test ends as `passed`, so
it is *already* in the trust numerator - paying +2 per heal on top counts the same event twice, and
it rewards a suite for needing a lot of repair rather than for repairing well. Scoring
`saved / entered` instead measures the loop's quality and is naturally bounded. The `entered >= 5`
guard stops one lucky heal out of one attempt reading as a 100% success rate.

Heal success in production, and what the loop is worth in raw trust points:

| App | entered heal | saved | success | trust | trust if self-heal did not exist |
|---|---|---|---|---|---|
| agree-com/agree-web | 69 | 40 | 58% | 35.5 | 26.8 (-8.7) |
| eddi/eddi-monorepo | 18 | 10 | 56% | 46.0 | 30.2 (**-15.8**) |
| centinel-finance/centinel-app | 50 | 22 | 44% | 30.8 | 25.4 (-5.4) |
| onecrew/one-crew | 29 | 9 | 31% | 64.5 | 59.2 (-5.3) |
| usehorizon-ai/horizon | 15 | 4 | 27% | 53.7 | 43.9 (-9.8) |
| autonoma/online-bank | 13 | 3 | 23% | 80.4 | 77.2 (-3.2) |
| britishfooddepot/bigcommerce-sync | 28 | 2 | 7% | 4.4 | 3.8 (-0.6) |
| sandstone, homa, eon, opticore | 0-1 | 0 | - | - | no loop activity at all |

## 4. Bands and gates

Bands on the final score:

| Score | Level |
|---|---|
| >= 85 | 5 PROVEN |
| 65 - 84 | 4 STEADY |
| 35 - 64 | 3 CALIBRATING |
| 15 - 34 | 2 AT RISK |
| < 15 | 1 DEGRADED |

Gates then clamp the band. **You cannot climb without evidence, and you cannot fall without evidence
either** - this is what keeps a brand-new app off both ends of the scale.

| Gate | Effect |
|---|---|
| runs < 8, or PRs < 3, or app younger than 7 days | cap at 3 - cannot reach STEADY |
| runs < 20, or PRs < 8, or app younger than 30 days, or any stale open issue, or no issue resolved in window | cap at 4 - cannot reach PROVEN |
| runs < 5 | floor at 3 - cannot fall to AT RISK |
| runs < 12 | floor at 2 - cannot fall to DEGRADED |
| no analysis run ever | 3 CALIBRATING, copy: "waiting for your first pull request" |

"App age" is the time since the app's **first analysis run of any pipeline**, not since the merged
pipeline shipped. Keying it to `AnalysisJob` alone resets every existing customer's clock.

### Inactivity

- No run in 21 days, **and** open issues exist: drop one level per additional 14 days, floor 1. This
  is the "nobody is using the platform and it has rotted" case.
- No run in 21 days, **and** nothing open: the level simply stops moving, because the window stops
  changing. There is no explicit "inactive" state - `SuiteHealth` carries no such flag and the meter
  is not greyed. `evidence.daysSinceLastRun` is the only signal a surface could use to say so.

### Hysteresis - NOT SHIPPED

The level is computed statelessly on every read, so it can move on any run that changes the window.

Damping it - "a newly computed level must hold for 2 consecutive runs or 24 hours, and may drop at
most one level per day" - needs a stored `lastLevel` / `lastLevelAt`, which is a migration. Until
that lands the meter can flicker on a run that shifts the score across a band boundary. The
inactivity decay above IS shipped: it is stateless, derived from `daysSinceLastRun`.

## 5. Validation against production (2026-07-31)

Every app with analysis data, keyed by org so a dogfood copy is never merged with the customer's
own. `trust` is the base rate, `score` is after modifiers, supersessions excluded.

| App | runs | PRs | findings | trust | blocked | mismatch | engine | heals | score | level |
|---|---|---|---|---|---|---|---|---|---|---|
| autonoma/online-bank | 20 | 12 | 89 | 79.8 | 2 | 12 | 4 | 3 | 85.8 | **4 STEADY** (band 5, held by PROVEN gates) |
| onecrew/one-crew | 20 | 12 | 72 | 58.3 | 15 | 14 | 1 | 3 | 64.3 | 3 CALIBRATING |
| usehorizon-ai/horizon | 8 | 5 | 41 | 53.7 | 5 | 12 | 2 | 4 | 60.0 | 3 CALIBRATING |
| agree-com/agree-web | 20 | 12 | 109 | 48.6 | 31 | 16 | 9 | 14 | 56.6 | 3 CALIBRATING |
| eddi/eddi-monorepo | 13 | 9 | 63 | 46.0 | 14 | 11 | 9 | 10 | 54.0 | 3 CALIBRATING |
| autonoma-ai/agent | 4 | 4 | 38 | 15.8 | 24 | 7 | 1 | 3 | 21.8 | 3 (floored, 4 runs) |
| vercel/devansh-portfolio | 2 | 1 | 12 | 8.3 | 11 | 0 | 0 | 0 | 8.3 | 3 (floored, 2 runs) |
| cal / bow / prs-walmart | 3-4 | 2-4 | 9-19 | 0.0 | most | - | - | 0 | 0.0 | 3 (floored) |
| centinel-finance/centinel-app | 20 | 13 | 79 | 26.6 | 51 | 4 | 3 | 3 | 32.6 | **2 AT RISK** |
| project/opticore | 6 | 1 | 37 | 0.0 | 37 | 0 | 0 | 0 | 0.0 | **2 AT RISK** (floored, 6 runs) |
| eon/eon-app | 8 | 3 | 38 | 2.6 | 35 | 0 | 2 | 0 | 2.0 | **2 AT RISK** (floored, 8 runs) |
| sandstone/sandstone | 20 | 16 | 143 | 8.4 | 5 | 1 | 125 | 0 | 8.4 | **1 DEGRADED** |
| britishfooddepot/bigcommerce-sync | 20 | 14 | 167 | 4.8 | 139 | 14 | 6 | 1 | 6.8 | **1 DEGRADED** |
| homa/homa-next | 20 | 9 | 167 | 0.0 | 167 | 0 | 0 | 0 | 0.0 | **1 DEGRADED** |

Distribution: 0 PROVEN, 1 STEADY, 9 CALIBRATING, 3 AT RISK, 3 DEGRADED. Centred on CALIBRATING,
which is what the model is supposed to do.

Nobody is PROVEN today, and that is correct - PROVEN should take about a month of real use to earn.
`online-bank` is the closest and would reach it in a few weeks of the same behaviour.

The three DEGRADED apps deserve it: `homa-next` is 100% `scenario_issue` (its recipe has never
worked), `bigcommerce-sync` is 83% blocked on environment + scenario, `sandstone` is 87%
`engine_artifact` (our engine crashing, not their app).

### The 54-64 cluster is the whole product story

Four real customers - one-crew (64.3), horizon (60.0), agree-web (56.6), eddi (54.0) - sit inside a
ten-point band, and there is a 21-point gap on either side of them (online-bank at 85.8 above,
centinel at 32.6 below). Any band boundary drawn between 54 and 64 splits a group that is genuinely
in the same place: roughly half of every run reaches a verdict you can act on.

That is an argument for keeping STEADY at 65 rather than lowering it to 60 to promote two of them.
STEADY's copy promises "failures you see now are much more likely to be real bugs" - at 58% trust,
four in ten still are not. Lowering the bar to make the meter greener is the one thing that would
make this feature worthless.

The way to keep them from feeling stuck at 3/5 is not a lower threshold, it is a **tooltip that
names the specific thing costing them the most**, because the four are failing for entirely
different reasons:

| App | Dominant loss | What the tooltip should say |
|---|---|---|
| horizon | `plan_mismatch` 12/41 (29%), blocked only 12% | Environment and test data are solid - second-best of any app. The tests themselves are still wrong about the app; more PRs converge them. |
| agree-web | blocked 31/109 (28%), but 14 self-heals - the highest heal count of any customer | Self-healing is working hard. The preview environment and test data are what is holding it back. |
| one-crew | blocked 15, mismatch 14 - evenly split | Closest to STEADY. No single dominant cause. |
| eddi-monorepo | blocked 14, mismatch 11, engine 9 - no dominant cause | Nothing single to point at. The most balanced profile of the four, and the one most dependent on self-heal. |

A single opaque number tells all four "you are at 3/5". The breakdown tells horizon to keep shipping
PRs and tells agree to go fix its preview environment - opposite actions.

### eddi is the case that justifies the self-heal term existing

`eddi/eddi-monorepo` (a real customer, `eddifi.ai`) sits at 46.0 trust / 54.0 score - the bottom of
the cluster. It clears the STEADY evidence gates comfortably (13 runs, 9 PRs); it is held back
purely by score.

What makes it interesting is that **18 of its 63 findings entered the self-heal loop and 10 came out
passing.** Strip self-healing out and eddi's trust falls 46.0 -> 30.2, which is AT RISK. No other
app depends on the loop that heavily. The thing STEADY's copy promises - "the agent is healing drift
on its own" - is already happening at eddi, one level early.

Its losses are unusually evenly split (14 blocked / 11 plan_mismatch / 9 engine_artifact), so unlike
horizon or agree there is no single lever to name in the tooltip. What the finding headlines do show
is a clean split of responsibility:

- **Theirs, and concretely fixable**: `SDK returned HTTP 500: Invalid \`p...\`` (x4 - their
  Environment Factory endpoint erroring), `Missing LaunchDarkly configuration hides the Upload
  Requests surface`, `Seeded user lacks SuperAdminGrant needed for Upload Requests`.
- **Ours**: `Runner recorded zero browser steps after successful provisioning`, `Browser agent
  abandoned the working Grant Scout flow before sending a message`, `The browser agent never clicked
  the rendered Grant Scout card`.

That split is the strongest argument for the tooltip breakdown over a bare number: eddi's operator
can act on the first group today and should not be made to feel responsible for the second.

## 6. What the UI shows

Sidebar meter, from the design:

```
SUITE HEALTH                    [ CALIBRATING ]
▂▄▆░░                                      3/5
21 runs · 3 PRs · 2 self-heals
```

- `21 runs` - runs in the window
- `3 PRs` - distinct branches in the window
- `2 self-heals` - successful self-heals in the window

Tooltip footer line, per level, all data-backed:

As `suiteHealthFooter` actually resolves them, in precedence order:

| Condition | Footer |
|---|---|
| never run | `Waiting for your first pull request` |
| AT RISK or DEGRADED with stale issues | `{n} failures are waiting on a decision` |
| CALIBRATING | `Most suites reach Steady in ~2 weeks` |
| STEADY with self-heals | `Self-healed {n} tests in the last {runs} runs` |
| anything else (incl. PROVEN) | `{trust}% of the last {runs} runs reached a verdict` |

PROVEN has no footer of its own: "0 false alarms" would need a false-positive signal we do not
collect, so it falls through to the trust rate, which we do.

## 7. The fix prompt

The "Fix it" modal hands the whole backlog to a coding agent in one prompt, authored server-side from the same
rows the plan is built from. Three things it is opinionated about, each from a real failure mode:

- **It names the server.** An agent holding several MCPs cannot resolve "the Autonoma MCP" and will pick one,
  so the first line says `autonoma` verbatim.
- **Open pull requests first, never oldest first.** A closed pull request needs no fix - at most its run
  explains a failure still live elsewhere - so it is listed as reference material under "do NOT go fix these",
  capped shorter than the open list.
- **Fix shared causes once.** The same failure typically lands on every open pull request at once, so the
  backlog is far smaller than its count. The prompt names the repeats with their span.

That last one is the whole leverage, and it is measured rather than asserted. Findings are clustered by exact
(normalised) title across branches; a cluster spanning fewer than 2 branches is dropped. In production:

| App | Clusters found | Effect |
|---|---|---|
| `homa/homa-next` | `Scenario setup failed ... SDK returned HTTP 500: Forbidden` on **10 branches / 185 findings** | One fix clears ~85% of a 200-finding backlog |
| `centinel-finance/centinel-app` | none - every issue title is distinct | The section is omitted entirely |

Exact matching only, deliberately: a fuzzy match would invent relationships between genuinely different
failures, and a wrong "fix this once and 10 PRs clear" is worse than no hint. `centinel` shows the honest
negative - once the Reporter is authoring bespoke per-branch titles there is nothing to cluster, and the prompt
says nothing rather than guessing.

## 8. Copy that needs to change

The design's RAISES IT / LOWERS IT lists name three signals we cannot currently measure:

| Design copy | Problem | Replacement |
|---|---|---|
| "Runs that pass on your main branch" | Main-branch runs are 13 of 495 in production. Almost nobody has this signal. | "Tests that pass when the agent checks a pull request" |
| "You confirming a flagged bug is real" | There is no confirm/dismiss action on `AnalysisIssue`. Only the Reporter agent resolves issues. | "A flagged bug fixed before the PR merges" (backed by `BugFixOutcome.fixed_before_merge`) - or build the confirm action, which is worth doing on its own merit |
| "Tests that flake more often than they pass" | Accurate, keep. | - |
| "Failures left unresolved for days" | Accurate, keep. | - |

Also worth adding to LOWERS IT, since it is the single largest real-world driver (39% of all
findings in production): **"Preview environments or test data that keep failing"**.

## 9. Open decisions

1. **Milestones.** The plan is to remove the sidebar milestone bar in favour of this. Suite health
   is a running quality signal; milestones are a one-time setup checklist. They do not both belong
   in the sidebar. Milestones could move into the onboarding surface rather than being deleted.
2. **MCP as a PROVEN gate.** MCP usage is trackable (`ScenarioRecipeEdit.source = 'MCP'`, PostHog
   `mcp.tool_called`). Recommendation: do **not** gate on it. Gate on the outcome (issues resolved),
   not on which tool did the resolving.
3. **Per-org vs per-app.** This spec is per-application. An org-level roll-up is a separate question.
