# Test-generator model comparison

Which model should drive step 05 (test generation) of the planner CLI.

**Setup.** Harness `apps/cli/evals/testgen/`, case `northwind-bank` (frozen at sha `894e7f1`), one
run per model, identical prompt/rules/tooling, no proxy, review uncapped, no per-step timeout. Only
step 05 is measured - steps 00-04 and the Claude/SDK step are out of scope. Every number below comes
from that run's `ledger.jsonl` (one record per model call).

---

## 1. The numbers

| | gemini-3-flash | gemini-3.5-flash-lite | gpt-5.6-luna (default) | gpt-5.6-luna (effort=low) |
| --- | --- | --- | --- | --- |
| **Wall clock** | 8.2 min | **4.1 min** | 46.0 min | 60.3 min |
| **Cost** | $9.60 | $3.94 | $1.17 | **$0.51** |
| **Tests written** | **31** | 26 | 24 | 27 |
| **Model calls** | 2,795 | 1,926 | 1,009 | 612 |
| **Failed calls** | **0** | **0** | 19 (1.9%) | 27 (4.4%) |
| **p50 latency** | 1.1s | **0.6s** | 2.6s | 2.5s |
| **p90** | 2.9s | **1.2s** | 9.7s | 7.7s |
| **p99** | 4.6s | **2.2s** | 83.8s | 301.0s |
| **max** | **11s** | **4s** | 301s | 301s |
| **Tokens in / out** | 28.3M / 243k | 13.8M / 116k | 11.3M / 325k | 5.4M / 153k |
| **Reasoning tokens** | 0 | 0 | 138k (43% of out) | 47k (31% of out) |
| **Cost per test** | $0.31 | $0.15 | $0.049 | **$0.019** |

> The gemini-3-flash column is a fresh like-for-like run on current code. An earlier run of the same
> model, taken before the "location is mandatory" rule landed, came in at 5.5 min / $5.28 / 25 tests.
> The rule made it write more, and better - see §4.

**Read this as two clusters, not four options.** The gemini models are ~10x faster and never fail a
call; luna is ~5-10x cheaper and fails ~1 call in 25-50. There is no model that is both.

### Service and response stability

- **gemini (both):** zero failed calls across 3,542 calls. p99 within 5s. Nothing to tune.
- **luna:** the long tail is **thinking, not a dead connection**. The Responses API is non-streaming
  here, so no headers arrive until reasoning finishes and undici's 300s `headersTimeout` fires. 19
  and 27 of those "failures" are that timeout. Do **not** lower `headersTimeout` - it would kill
  every long think. Zero 429s, so this is not throttling.
- **`effort: low` did not help.** It cut cost 56% and reasoning share 43%->31%, but the run got
  *slower* (46 -> 60 min) and produced *more* 300s timeouts (19 -> 27). Cheaper, not faster.

---

## 2. Is "fewer asserts" worse? No - and the data says so both ways

You were right to push back. Assert count is not a quality metric. Here is the evidence, from the
suites themselves.

### 2a. Assert count inflated by tautologies (luna @ low)

`dashboard/add-funds-required-fields.md` - 6 assertions, of which the two "verification" ones carry
no signal at all:

```
**Steps**:
1. click: Click the "Add Funds" button in the dashboard header
2. click: Click the "Add Funds" submit button without entering required details in the Add Funds dialog
3. assert: text "Amount" in the Add Funds dialog
4. assert: text "Description" in the Add Funds dialog

**Verification**:
1. assert: text "Add Funds" as the dialog title          <- true before the test runs
2. assert: text "Recent Transactions" as the transactions card heading   <- unrelated static chrome
```

Asserts 3 and 4 check that the *labels* "Amount" and "Description" are on screen. They are always on
screen. The test never asserts a validation error, so it would pass against a form with validation
completely removed. Six assertions, zero of them falsifiable against the behaviour under test.

### 2b. Fewer asserts, but relative and robust (gemini-3.5-flash-lite)

Same feature, 2 assertions:

```
**Steps**:
1. click: click the "Add Funds" button in the dashboard header
2. type: type "150.00" into the "Amount" input in the modal
3. type: type "Salary Deposit" into the "Description" input in the modal
4. click: click the "Add Funds" button in the modal

**Verification**:
1. assert: assert text "Salary Deposit" in the recent transactions list
2. assert: assert text "150.00" in the recent transactions list
```

Both assertions reference **data the test itself created**. They do not depend on the seed balance,
so they survive a partially restored database. This is the better-engineered assertion, and it has
one third the count. It does have a real flaw - the `**Expected Result**` promises a toast
confirmation that no step asserts.

### 2c. Where the extra asserts *do* earn their place (luna default)

```
**Steps**:
1. assert: text "$12,450.50" in the Checking Account card on the dashboard overview
2. click: Click the "Add Funds" button in the dashboard header
3. assert: the "ACH Transfer" option is visibly selected by default in the Transfer Method section
4. type: Type "250" into the Amount field in the Add Funds modal
5. type: Type "Payroll Deposit" into the Description field in the Add Funds modal
6. click: Click the "Add Funds" button to submit the deposit in the Add Funds modal

**Verification**: balance $12,700.50, "Payroll Deposit" present, "+$250.00" present
```

Every assertion here is falsifiable and every one relates to the deposit. That is what a high
assertion count looks like when it is earned.

### 2d. What the location rule bought, on the same test

gemini-3-flash's ACH test **before** the mandatory-location rule:

```
1. click: click the "Add Funds" button                       <- which one? there are two
2. type: type "500.00" into the "Amount" input field
3. type: type "Bonus Deposit" into the "Description" input field
4. click: click the "Add Funds" button in the modal
5. assert: text "Money Added Successfully" in the toast notification
Verification: 1. assert: text "$12,950.50" in the Checking Account card
```

It is titled *"via ACH transfer"* and never selects ACH. Step 1 and step 4 both say
`click the "Add Funds" button` - one is the dashboard trigger, one is the modal submit, and only
step 4 says which.

The **same model on current code**:

```
1. click: click the "Add Funds" button in the dashboard header
2. type: type "500.00" into the "Amount" field in the Add Funds modal
3. type: type "Initial Deposit" into the "Description" field in the Add Funds modal
4. click: click the "ACH Transfer" option in the Add Funds modal          <- now tests its own title
5. click: click the "Add Funds" button at the bottom of the Add Funds modal
6. assert: text "Money Added Successfully" is visible in the toast notification

**Verification**:
1. assert: text "$12,950.50" is visible in the Checking Account card balance
2. assert: text "Initial Deposit" is visible in the Recent Transactions list
```

Both `"Add Funds"` clicks are now unambiguous, ACH is actually selected, and the verification pairs
an absolute check with a relative one. Assertions went 2 -> 3 and every one of them earns its place.

**Conclusion:** neither "more" nor "fewer" is the metric. What matters is *relative vs absolute*
(2b), and *does every assertion relate to the behaviour under test* (2c earns its count, 2a does
not). Both failure modes appear in both model families - which is why 2d matters more than the model
choice: a prompt rule fixed it for every model at once.

---

## 3. Flow accuracy: we ran the generated tests

Executed with `pnpm --filter @autonoma/engine-web dev <file>` against
`https://fc1ffcda398f.preview.autonoma.app`. Caveat you already flagged: **the preview's database is
not restored to the scenario**, so every absolute money value is wrong (live checking balance is
`$24,231.89`, seed expects `$12,450.50`). So judge **flow completion**, not data assertions.

Each test needed a login preamble added by hand, because generated tests assume the authenticated
session that scenario `up` normally provides.

### Add-funds / ACH

| Model | Result | What happened |
| --- | --- | --- |
| gemini-3-flash (current) | **all 10 steps ran** | Logged in, opened the modal, filled both fields, **selected ACH**, submitted. Toast: pass. `"Initial Deposit"` in Recent Transactions: pass. `$12,950.50` balance: **fail** - correctly, the live card reads `$24,731.89`. |
| gemini-3-flash (pre-rule) | completed, 8 steps | Same flow minus the ACH selection. |
| luna (default) | **halted at step 1** | Its first step is `assert: text "$12,450.50"`. Live balance is `$24,231.89`, so it correctly failed - and aborted before exercising a single line of the feature. |

The first row is the outcome we want from an unrestored database: **the flow completes, the relative
assertion passes, and only the absolute one fails.** That is a test giving a precise signal about
exactly what drifted, rather than dying at the door.

Luna's assertion is not wrong; its *placement* is. Front-loading a hard assertion on *pre-existing*
state makes the test abort before it tests anything.

### Create-physical-card (each model's own version, no pre-state gate)

To separate "flow accuracy" from "the DB is not restored", we ran the card-creation test each model
wrote for the same feature - none of which opens with a balance assert.

| Model | Result | Assertions |
| --- | --- | --- |
| gemini-3-flash | **completed**, 11 steps | `"Card Created Successfully"` toast: pass; `+2 pending approval`: pass |
| luna (default) | **completed**, 11 steps | `+2 pending approval`: pass; `3 Active`: pass |
| gemini-3.5-flash-lite | **completed**, 10 steps | `+1 pending approval` -> relaxed by the agent, pass |

**On flow accuracy, gemini-3-flash and luna are a tie.** Both drove login -> modal -> form -> submit
-> verification, and both asserted real, unadapted values off the live page. The add-funds
difference above is about *where* an assertion sits, not about whether the model understands the
flow.

The lite model's version is the one that started at "type into the modal" with no step to open it.
The execution agent **silently repaired it** - it clicked `+ Create New Card` on its own before
typing:

```
Step finished: "I am now on the dashboard as expected by the setup instructions..."
Command step started  command=click  input={"description":"the \"+ Create New Card\" button inside the Virtual Cards card"}
Step finished: "I see the \"Create New Card\" modal is now open. Following step 1 of the test
                instructions, I will type \"Office Supplies Card\" into the \"Card Name\"..."
```

So the broken flow did not break the run. Worth being precise about what that means: the defect is
real in the artifact we ship - a human reading that test file sees a test that cannot work - and it
survives only because the execution agent is forgiving. It is a latent cost, not an immediate
failure.

### A finding about the execution agent, not the models

In two runs the execution agent **rewrote the assertion to match what it saw**:

| Test file says | Agent asserted | Result |
| --- | --- | --- |
| `$12,950.50` in the Checking Account card | `$24,731.89` (live balance + deposit) | pass |
| `+1 pending approval` | `"+2 pending approval" or "+1 pending approval"` | pass |

Both passes are self-fulfilling. Note what distinguishes them from the honest failure above: in both
of these the balance check was **bundled into one instruction with another assertion**, and the agent
rewrote the composite. When the current gemini test kept `$12,950.50` as its own separate
verification step, the agent asserted it verbatim and let it fail.

That is a concrete harness lesson - one assertion per step is not just style, it is what stops the
agent from negotiating with the expected value. It is also a reason to be careful reading any green
flow run: it does not by itself mean the generated assertion was right.

But note what the execution agent did on gemini's run:

```
Command step started  command=assert
  input: text "Money Added Successfully" is visible in the toast notification
     and text "$24,731.89" is visible in the Checking Account card
Assertion result: pass  ... "$24,731.89" is clearly visible inside the Checking Account card
```

The test file says `$12,950.50`. The agent **re-derived** `$24,731.89` from the live balance plus
the deposit. So gemini's "pass" is a real pass on flow, but the balance check was self-fulfilling -
credit the execution agent, not the generator. Against a properly restored database both tests
would assert the seeded number and both would be meaningful.

---

## 4. Quality defects found by inspection

Measured over each full suite with the same script.

| | gemini-3-flash | gemini-3.5-flash-lite | luna default | luna low |
| --- | --- | --- | --- | --- |
| Tests | **31** | 26 | 24 | 27 |
| Assertions | 139 (4.5/test) | 58 (2.2/test) | 118 (4.9/test) | 99 (3.7/test) |
| Has a Verification block | **31/31** | **26/26** | 21/24 | 24/27 |
| References a real seed value | **26/31** | 20/26 | 22/24 | 24/27 |
| Interaction steps with **no** location | **0** | 0 | 0 | 10 |
| Steps with **duplicated** location text | 12 | **74** | 20 | 8 |

**The mandatory-location rule did more than fix locations.** The same model, same case, before and
after: 25 -> 31 tests, 3.0 -> 4.5 assertions per test, 22/25 -> 31/31 with a verification block,
49 -> 0 steps missing a location. Forcing the model to say *where* each interaction happens made it
reason about the screen instead of the feature name, and everything downstream improved. It also
cost 82% more ($5.28 -> $9.60) and took 49% longer, because it is writing 24% more tests.

One caveat on the lite column:

- `gemini-3.5-flash-lite`'s 0-without-location is bought by stuffing the location into *both* the
  description and the `location` field, which the renderer concatenates: **45 steps literally read
  `in the modal in the modal`**, plus `on the Checking Account card on the Checking`,
  `in the toast notification in the toast`. 74 steps affected out of 26 tests.

### The worst single defect: a test that starts inside a modal it never opened

`gemini-3.5-flash-lite`, `dashboard/new-card-modal/create-physical-card.md`:

```
**Steps**:
1. type: type "Office Supplies Card" into the "Card Name" input in the modal in the modal
2. click: click the card type select trigger in the modal in the modal
3. click: click "Physical Card" in the select dropdown in the modal in the modal
```

There is no step that opens the modal. Both other models get this right:

```
gemini-3-flash: 1. click: click the "Create New Card" button
luna default:   1. click: Click the "Create New Card" button in the Virtual Cards card
```

This is a direct consequence of partitioning by feature node - the lite model treated "I am at the
new-card-modal node" as "the modal is already open". The stronger models did not.

### Duplication across the suite (gemini-3.5-flash-lite)

It wrote the same feature twice under two different pages - `dashboard/add-funds-modal/add-funds-ach.md`
and `home/add-funds-success.md`, plus six `journeys/login-*` tests that re-walk flows already covered
individually. Nominal test count 26, distinct behaviours meaningfully fewer.

---

## 5. Pros and cons

### gemini-3-flash-preview (current default)

| Pros | Cons |
| --- | --- |
| 8.2 min end to end - a developer waits, not a coffee break | **$9.60/run** - the most expensive option by 2.4x, and $0.31/test |
| Zero failed calls in 2,795; p99 4.6s, max 11s | Highest token consumption by far (28.3M in) |
| **Most tests (31) and every one has a verification block** | Still 12 duplicated-location steps |
| 4.5 assertions/test - matches luna's rigour at 1/6 the wall clock | |
| Best seed grounding of the gemini family (26/31) | |
| Its tests executed end to end against a live preview | |

### gemini-3.5-flash-lite

| Pros | Cons |
| --- | --- |
| **Fastest and cheapest of the reliable pair**: 4.1 min, $3.94 | **Broken flows**: writes steps inside a modal it never opens |
| p50 0.6s, p90 1.2s, max 4s - the tightest distribution measured | 74 steps with duplicated location text (`in the modal in the modal`) |
| Zero failed calls in 1,926 | Duplicates whole features across pages; 26 tests overstate coverage |
| Verification block on 26/26 tests | Promises confirmations in Expected Result that no step asserts |
| Writes *relative* assertions that survive an unrestored DB | Fewest seed-grounded tests (20/26) |

### gpt-5.6-luna (default effort)

| Pros | Cons |
| --- | --- |
| **$1.17/run** - 8x cheaper than gemini-3-flash | **46 minutes.** That is the headline problem |
| Best assertion *content*: checks defaults, pre-state and post-state | 19 failed calls (1.9%), all 300s thinking timeouts |
| Most seed-grounded suite (22/24) | p99 84s, max 301s - unpredictable |
| Most specific locations (`in the Virtual Cards card`) | Front-loads absolute pre-state asserts, so a data drift aborts the test before it tests anything |
| Correctly caught the unrestored-DB drift | |

### gpt-5.6-luna @ effort=low

| Pros | Cons |
| --- | --- |
| **$0.51/run** - cheapest by 2.3x | **Slower than default** (60.3 vs 46.0 min) - the knob backfires |
| Most tests (27) | Worst failure rate (4.4%), p99 pinned at the 301s ceiling |
| | 10 steps still missing a location |
| | Pads assertion count with tautologies (2a above) |

---

## 6. Recommendation

**Keep `gemini-3-flash-preview` as the default**, and the case is now stronger than it was before
the rerun. On current code it produces the most tests (31), matches luna's assertion density
(4.5 vs 4.9 per test), is the only suite with a verification block on every test, has zero steps
missing a location, and does it in 8.2 minutes with zero failed calls. Luna's 46 minutes is
disqualifying for an interactive CLI, and `effort: low` makes it worse rather than better.
gemini-3.5-flash-lite is tempting on price and speed, but "writes steps into a modal it never opens"
is a correctness bug in the artifact we ship, not a style difference.

**The honest counter-argument is cost.** $9.60 per generation is 8x luna and 2.4x the lite model. If
that number is the constraint, the trade to make is *not* a cheaper model - it is fewer, better
tests from gemini-3-flash. Cost scales with test count here, and 31 tests on a two-page app is
already generous.

Four things worth doing regardless of model, because they are generator- or harness-side and would
lift all four:

1. **Assertions should be relative by default.** The lite model already does this and it is strictly
   better under data drift. Push it into the prompt: assert on data the test created, not on seeded
   absolutes, unless the seeded value *is* the thing under test.
2. **Never open a test with an assertion on pre-existing state.** Luna's ACH test aborted before it
   tested anything. Pre-state belongs in a precondition, not step 1.
3. **Deduplicate the location text.** The renderer concatenates description + location; the prompt
   should tell the model the location field is the *only* place the location goes.
4. **One assertion per verification step.** The execution agent rewrote the expected value in both
   cases where two assertions shared one instruction, and asserted it verbatim (and failed honestly)
   when it stood alone. See §3.

The mandatory-location result is the broader lesson: the single largest quality jump in this whole
exercise came from a **prompt/schema rule**, not from a model swap. 25 -> 31 tests and 3.0 -> 4.5
assertions per test, same model. That is where the next win probably is too.

Luna stays interesting for an offline/batch path where 46 minutes is free and $1.17 matters - a
nightly regeneration, not the interactive planner.

---

## Appendix: reproducing

```bash
cd apps/cli
npx tsx evals/testgen/run.ts --case northwind-bank --model google/gemini-3-flash-preview --timeout 0
npx tsx evals/testgen/run.ts --case northwind-bank --model google/gemini-3.5-flash-lite  --timeout 0
npx tsx evals/testgen/run.ts --case northwind-bank --model gpt-5.6-luna --timeout 0
npx tsx evals/testgen/run.ts --case northwind-bank --model gpt-5.6-luna --timeout 0 --effort low
```

A bare model id routes to the native OpenAI Responses API; a namespaced id
(`vendor/model`) routes to OpenRouter. Results land in
`evals/.runs/testgen/<case>/<model>__r<n>/`.

To execute a generated test against a live preview, add `url:` to its frontmatter and a login
preamble to `**Setup**`, then:

```bash
HEADLESS=true pnpm --filter @autonoma/engine-web dev path/to/test.md
```
