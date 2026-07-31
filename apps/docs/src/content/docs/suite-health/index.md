---
title: Suite health
description: The five-state signal in your Autonoma sidebar - what each level means, exactly how the score is calculated from your analysis runs, and why every new app starts at Calibrating rather than at zero or at green.
---

<p class="lead">Suite health answers one question: how much should you trust a failure this suite reports? It is a five-step ladder, and every new app starts in the middle.</p>

![A row of five vertical bars rising left to right like a signal-strength meter. The two leftmost bars are dark and unlit; the three rightmost glow bright lime, showing a signal that grows stronger as the suite proves itself.](/img/suite-health/hero.jpg)

Autonoma writes your test suite by reading your code. It has never operated your app. Some of what it wrote is wrong - an assertion about a screen that renders differently, a flow that needs a login step nobody documented - and it only finds out by running against real pull requests.

Suite health says that out loud, and shows it improving.

## The five levels

| Level | What it means |
| --- | --- |
| **Proven** 5/5 | Every failure here is worth reading. False alarms are rare. |
| **Steady** 4/5 | Tests are holding across pull requests and the agent is healing drift on its own. |
| **Calibrating** 3/5 | New suite. Written from your app, not yet proven against it. Expect some noise. |
| **At risk** 2/5 | More tests are flaking than passing. A few decisions from you will fix it. |
| **Degraded** 1/5 | Failures are piling up unresolved. The agent can no longer tell a real bug from a stale test. |

Every new app starts at **Calibrating**. Not at zero, and not at green - both would be lies. A suite that has never run is not broken, and it is not proven either.

## What is measured

The score is the **trust rate**: of the tests Autonoma investigated, how many produced a verdict you can act on.

```
trust = (passed + confirmed bug) / every finding in the window
```

Every analysis run resolves each test it investigated to one verdict. Only two of them tell you something true about your application:

| Verdict | Counts toward trust? | Why |
| --- | --- | --- |
| Passed | Yes | The app did what the test expected. |
| Bug | **Yes** | The app misbehaved, and the suite caught it. |
| Environment failure | No | The preview was unavailable, so nothing was tested. |
| Test data issue | No | The scenario was mis-seeded, so nothing was tested. |
| Engine artifact | No | Our test harness flaked or crashed. |
| Plan mismatch | No | The app was fine; the test does not match it yet. |

:::note
**A confirmed bug raises your suite health, it does not lower it.** A suite that finds a real bug is a suite doing its job. What lowers health is a run that reaches no verdict at all - because then a failure tells you nothing.
:::

### The window

The score is computed over your **last 20 analysis runs**, no older than 30 days.

- Both pull-request runs and main-branch runs count.
- A run that selected no tests is excluded entirely. It is neither good nor bad.
- A run counts once no matter how many tests it investigated, so one large pull request cannot swing the number on its own.

Runs rather than calendar days, because a busy repository produces a hundred runs in a week and a quiet one produces three in a month. A fixed time window makes the first number twitchy and the second meaningless.

## What moves it

| Raises it | Lowers it |
| --- | --- |
| Tests that pass when Autonoma checks a pull request | Failures left unresolved for days |
| Autonoma self-healing a test inside a pull request | Tests that flake more often than they pass |
| A flagged bug fixed before the pull request merges | Preview environments or test data that keep failing |

Four bounded adjustments sit on top of the trust rate. None can dominate:

| Adjustment | Effect |
| --- | --- |
| **Self-heal rate** | Up to +8, scaled by how often a re-planned test then passes. Needs at least 5 attempts, so one lucky heal is not a perfect score. |
| **Triage** | +5 when you resolve an issue in the window, +10 for three or more. |
| **Pipeline failures** | Up to -15 when analysis runs die outright. A run that never finishes produces no findings, so it would otherwise be invisible. |
| **Stale failures** | -5 per open issue older than a week on a live branch, capped at -20. |

:::note
Self-heal is scored as a **rate**, not a count. A healed test already lands in the trust rate as a pass, so paying per heal would count it twice - and would reward a suite for needing a lot of repair rather than for repairing well.
:::

## Why you cannot jump straight to Proven

The score alone does not set the level. Evidence gates clamp it, in both directions.

| You cannot reach | Until |
| --- | --- |
| **Steady** | 8 runs, 3 pull requests, and a week of history |
| **Proven** | 20 runs, 8 pull requests, a month of history, no stale open failures, and at least one issue you resolved |

And symmetrically - **you cannot fall without evidence either**:

| You cannot drop to | Until |
| --- | --- |
| **At risk** | 5 runs |
| **Degraded** | 12 runs |

This is what keeps a brand-new app off both ends of the scale. Three unlucky runs in your first week is not a degraded suite, and three lucky ones is not a proven one.

Most suites reach Steady in about two weeks of normal pull-request traffic. Proven takes roughly a month, on purpose.

## Going quiet

If nothing runs for three weeks **and** you have unresolved failures sitting open, the level decays a step, and another for every two weeks after that. That is the "nobody is using it and it has rotted" case, and it is the one situation where the evidence floors do not protect you - a week-old untriaged failure is its own evidence, whatever your run count says.

Silence on its own is not a failure. With a clean backlog, the level simply stops moving.

## Two suites at the same level can need opposite things

The level tells you how much to trust a failure. It does not tell you what to do, because the same score arrives by very different routes.

Hover the meter and the tooltip names the dominant cause:

| If most failures are | Then |
| --- | --- |
| Test data | Your recipe is the fastest thing to fix. Nothing to do in your code. |
| Environment | Your preview could not run. A missing secret or a broken service. |
| Plan mismatch | Your environment is solid; the tests do not match the app yet. More pull requests converge them. |
| Engine artifact | Our test harness, not your app. That one is on us. |

Two real examples from the same level: one customer's environment and test data were among the healthiest we run and only their test plans lagged - they needed to keep shipping pull requests. Another had self-healing working hard but a flaky preview underneath it - more pull requests would not have helped at all.

When the level is At risk or Degraded, the tooltip grows a **Fix it** button that hands the whole backlog to your coding agent in one prompt. See [Fixing a degraded suite](/suite-health/fixing).
