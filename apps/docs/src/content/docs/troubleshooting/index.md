---
title: Troubleshooting
description: The questions people actually hit - what Autonoma supports and does not, why setup stalls, why a run has not started, how credits and billing work, and what we do with your code and data.
---

<p class="lead">The problems people run into most often, and what to do about each. If your question is about the Environment Factory specifically, the <a href="/environment-factory/security/">error-code reference</a> goes deeper.</p>

![Common setup problems and where each one is solved](/img/troubleshooting/hero.jpg)

## Is this supported?

The short answers, so you can find out in one line whether Autonoma fits.

| You want to | Supported |
| --- | --- |
| Connect a **GitHub** repository | Yes - this is the only source host |
| Connect GitLab, Bitbucket, or Azure DevOps | No |
| Test a **web** application | Yes |
| Test an iOS or Android app | No |
| Use Autonoma without a repository | No - reviews are driven by pull requests |
| Sign in with something other than Google | No |
| Push results to Jira, Xray, or another test-management tool | No |
| Have a coding agent act on the results | Yes - every PR gets a review comment written to be read by one |
| Run the planner without your own LLM API key | Yes - it runs on managed Autonoma credits |

If something you need is missing, tell us in the in-app chat. Knowing what people are blocked on is how this list gets shorter.

## Setting up

### The onboarding is stuck on step 1 after installing the GitHub App

Usually the app was installed by someone else - an organization owner approving the request - and the
install never got tied back to your session.

Have the owner uninstall the Autonoma GitHub App, then sign in to Autonoma yourself and install it
again from step 1. You can then finish onboarding without waiting on them.

### I installed the GitHub App but Autonoma does not see my repository

Check the app's repository access. If it was installed with **Selected repositories**, the repo you
want has to be in that list. Uninstalling and reinstalling from step 1 is the fastest fix.

### Can I delete an application and start over?

Not from the dashboard today. Ask in the in-app chat and we will remove it.

## The planner CLI

The planner is a command-line tool that reads your codebase and writes your test suite. It runs on
your machine, not on ours. Full reference: [Test Planner](/test-planner/).

### Where do I run the command?

In your own terminal, from the root of the repository you want to test. The planner reads your code,
so it has to be somewhere it can see it.

Copy the command from **Finish setup → Upload test artifacts** in the dashboard - it comes with your
token and generation id already filled in - and paste it into your terminal:

```bash
AUTONOMA_SHARED_SECRET=... AUTONOMA_DISTINCT_ID=... AUTONOMA_API_TOKEN=... AUTONOMA_GENERATION_ID=... npx @autonoma-ai/planner@latest
```

If your frontend and backend live in separate repositories, run it somewhere it can reach both, or
point it with `--frontend` and `--backends`.

### It has been on the same step for ages - is it stuck?

Probably not. A full run takes **an hour or more**. Building the knowledge base is the slowest early
step because it reads every page in your app.

The terminal dashboard shows you it is alive: the activity feed at the bottom logs each thing the
agent does, and the pane on the right streams the file being written right now. If both have been
frozen for a long stretch, that is worth reporting.

### I closed my terminal - do I have to start over?

No. Progress is saved continuously.

```bash
npx @autonoma-ai/planner@latest --resume   # pick up where it stopped
npx @autonoma-ai/planner@latest status     # see how far it got
```

`npx` does not install anything on your `PATH`, so a bare `autonoma-planner` will not work.

### The run finished but an artifact is missing

The **Upload test artifacts** step shows four chips - `recipe.json`, `qa-tests/`, `AUTONOMA.md`,
`scenarios.md` - and will not complete until all four arrive. The one that most often does not is
`recipe.json`, because it is produced and sent separately during the test-data step, while the other
three go up together at the very end.

**Do not re-run the whole planner, and do not use `--resume`.** Every step already finished, so there
is nothing to resume - it will print `All steps complete.` and exit without uploading. Re-send what is
already on your disk instead:

```bash
AUTONOMA_API_TOKEN=... AUTONOMA_GENERATION_ID=... \
  npx @autonoma-ai/planner@latest upload
```

The dashboard shows this exact command, with your values filled in, in the warning under the chips.
It is idempotent, so it is safe to run more than once.

If `recipe.json` is still missing afterwards, it was never generated - the test-data step did not
finish. That happens when no supported coding agent was available for the handoff, in which case the
planner wrote the integration instructions to `~/.autonoma/<project-slug>/integration-prompt.md`.
Complete that, then run `upload` again.

### Does it commit anything to my repository?

The test suite, knowledge base, and scenarios are written to `~/.autonoma/<project-slug>/` on your
machine and uploaded to Autonoma. None of it is committed to your repo.

The one exception is the test-data step, which is real code: your coding agent implements the
Environment Factory on **its own branch** and opens a pull request for you to review. Nothing lands
on your default branch unreviewed.

### Where do I write the tests?

You do not. The planner generates them from your codebase as natural-language markdown - not
Playwright or Cypress scripts - and uploads them itself.

### It is asking for an LLM API key

It should not be. The planner runs on managed Autonoma credits and needs no key of your own. Use
`--model` to pick a different Autonoma-hosted model, still without a key. If something is prompting
you for one, you are on an old version - re-copy the command from the dashboard.

## Test data

The Environment Factory is the endpoint that creates test data before each run. Its
[error-code reference](/environment-factory/security/#error-codes) covers the full list; these two
come up most in setup.

### `CONFIGURATION_ERROR` - shared secret and signing secret must be configured

Both `AUTONOMA_SHARED_SECRET` and `AUTONOMA_SIGNING_SECRET` have to be set in the environment where
your backend actually runs.

The usual miss is setting them locally but not in the deployed app Autonoma is calling. Check the
environment of the running service, not your shell. They must be two different values - see
[the two secrets](/environment-factory/security/#the-two-secrets).

### `UNRESOLVED_TOKEN` - unresolved token `{{something}}`

Your recipe uses a `{{token}}` that nothing defines.

Every token in `create` needs a matching entry under `variables`, with one exception:
[`{{testRunId}}` and `{{testRunShortId}}`](/reference/scenario-recipe-schema/#built-in-tokens) are
built in and need no declaration. So `{{org_name_1}}` in a `create` block with no `org_name_1`
variable fails the whole provisioning step.

Either declare the variable or fix the typo in its name.

## Runs and results

### What actually triggers a test run?

Pull request activity. Opening a PR, pushing to it, or reopening it builds the preview and runs the
suite against it. Closing the PR tears the environment down.

A repository can also keep a standing main-branch environment, which redeploys on every push to that
branch.

### Where is the preview URL?

Autonoma comments it on the pull request, and keeps that comment updated as the PR changes. One PR
can expose several apps, each with its own hostname.

### My test generations have been pending for a long time

Generation runs behind the planner upload, so it will sit idle until the CLI finishes and uploads.
If the upload has completed and generations still have not moved, that is a problem on our side -
report it in the in-app chat with your organization name.

### The CLI says it uploaded, but the dashboard is empty

Try a hard refresh first (`Ctrl` + `Shift` + `R`). If it is still empty, report it - the CLI and the
dashboard disagreeing is a bug, not something you can fix from your side.

## Billing and credits

Autonoma is **pay as you go**, metered in credits. New organizations start with a free balance, so
you can run real tests before paying anything.

Credits are spent on generating tests, running them, and on the planner CLI. When you run low, buy a
top-up under **Settings → Billing**, or turn on auto top-up to have it happen automatically at a
threshold you set. That page also shows your current balance, split between subscription and top-up
credits, and your full transaction history.

Rates are configured per organization, so the billing page is the source of truth for what your
account is charged. For a quote, or if a purchased top-up has not appeared on your balance, ask in
the in-app chat.

## Your code and your data

**Your code is not used to train models.** Autonoma does not train on customer codebases.

**Your codebase is not stored.** It is cloned when a test run or an analysis needs to read it, used for
that run, and not kept.

What is retained is **conversations** - agent runs, reviews, and support threads - which we keep for
debugging and to improve the product. Those transcripts can quote fragments of your code where an agent
read a file while working, so treat them as containing excerpts rather than nothing.

If you need this in writing for a review or an auditor, ask in the in-app chat.

## Still stuck

Use the in-app chat. Two things make it much faster to help:

- **Your organization or application name**, so we can find the right account.
- **The exact error text**, copied rather than described.

Never paste a signing secret, shared secret, or API token into the chat. We do not need it, and
anything pasted into a support conversation should be rotated afterwards.
