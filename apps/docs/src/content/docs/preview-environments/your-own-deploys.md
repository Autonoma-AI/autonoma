---
title: Use your own deploys
description: Connect the preview environments your pipeline already builds. Autonoma deploys nothing - your pipeline makes one signed call when a preview is live, and Autonoma runs its tests against that URL.
---

<p class="lead">If your project already builds a preview for every pull request, Autonoma does not need to build another one. Point it at the previews you have: your pipeline makes one signed HTTP call when a preview goes live, and Autonoma runs its tests against that URL.</p>

![A deployment pipeline carrying containers to the right, ending in a single bright signal pulse picked up by a waiting receiver](/img/preview-environments/your-own-deploys-hero.jpg)

This is the alternative to [Autonoma-hosted preview environments](/preview-environments/). You choose between them during onboarding - either by answering a short questionnaire or by letting a coding agent decide from your repo - and you can still switch while you are setting up.

On this path Autonoma builds nothing, provisions nothing, and holds no stack configuration for your app. There is no Dockerfile to point at and no database to declare. The entire integration is the one call described below.

## Which path to pick

The question is not "do previews already exist" - it is **where the test data lands**.

![Two options side by side. Autonoma-hosted: a preview browser and its own database enclosed together, labeled "its own database". Your own pipeline: a preview browser wired down to a much larger shared database labeled "staging", with leftover rows inside it beside a warning triangle labeled "data stays"](/img/preview-environments/where-test-data-lands.jpg)

An Autonoma-hosted preview gets its own database, so a test run creates and destroys rows in an environment nothing else shares. Your own previews usually point at a real shared database - commonly staging, sometimes production. A test run writes into it, and anything it creates that no tenant owns **stays there**. Picture a marketplace whose previews share one database: a run creates listings, and real users see them.

| Your situation | Pick |
| --- | --- |
| No preview environments today | Autonoma-hosted - there is nothing to connect to |
| Previews today, and every row hangs off a tenant (an org, account, or workspace you can delete whole) | Either. Your own is less to change |
| Previews today, but the data is **not** cleanly tenant-scoped | Autonoma-hosted, despite the previews you already have |
| Not sure | Autonoma-hosted |

The two mistakes are not symmetrical. Choosing Autonoma-hosted when you did not need to costs a preview environment we build for you anyway. Choosing your own pipeline when your data is not tenant-scoped writes test data into your real database, in front of your users, and it cannot be taken back.

:::note
"Tenant-scoped" means a test can create everything it needs underneath one deletable owner. If a test signs up an organization, works inside it, and deleting that organization removes every row it touched, you are tenant-scoped. Global tables that all tenants read - a shared product catalogue, a public listings table, a global search index - are what break this.
:::

## The contract

![Left to right: your pipeline, then preview is live, then a signed POST carrying an x-signature header, then Autonoma runs tests - with "branch + prNumber" labelling the final arrow](/img/preview-environments/deployment-signal-flow.jpg)

One `POST`, signed with a shared secret:

| | |
| --- | --- |
| **Endpoint** | `https://api.autonoma.app/v1/onboarding/deployment-signal` |
| **Method** | `POST`, `content-type: application/json` |
| **Signature** | `x-signature: <hex>` - HMAC-SHA256 of the **exact raw body bytes**, keyed with your shared secret |
| **Secret** | Shown on the **Connect your deploys** onboarding step; store it as `AUTONOMA_SHARED_SECRET` in your pipeline |

Sign the exact bytes you send. Serializing the JSON a second time after signing - a re-`JSON.stringify`, a formatter, a proxy that rewrites the body - changes the digest, and the call is rejected.

### Body

| Field | Required | What it does |
| --- | --- | --- |
| `applicationId` | yes | The app this preview belongs to. Shown on the onboarding step |
| `previewUrl` | yes | The URL Autonoma opens in a browser |
| `branch` | pair | The deployed branch. Send **with** `prNumber` |
| `prNumber` | pair | The pull request number. Send **with** `branch` |
| `sdkUrl` | no | Only when your [Environment Factory](/environment-factory/) endpoint is on a different origin than `previewUrl` |
| `sha` | no | The deployed commit |
| `provider` | no | Free-text label for where the deploy came from |

`branch` and `prNumber` travel together, and this is the detail most worth getting right:

- **Neither** - the signal is recorded as a main-branch deploy. Fine for the standing preview of your default branch.
- **Both** - Autonoma reviews that pull request. This is what turns a signal into a per-PR review.
- **`branch` without `prNumber`** - the signal is **dropped entirely**. Never send one without the other.

### Only signal the app Autonoma should browse

If one pull request deploys several things - a frontend, an API, a database - signal only the one Autonoma should open in a browser. Every signal overwrites the stored preview URL, so signalling all of them means whichever deploy finishes last wins, and that may well be your API rather than your frontend.

## A starter workflow

The **Connect your deploys** step hands you a GitHub Actions workflow, and your coding agent can fetch the same one over MCP. Treat it as a **template, not a requirement**.

It hangs off GitHub's `deployment_status` event, which is convenient when your host reports deployments back to GitHub - and which plenty of pipelines never emit. Autonoma requires only the signed call. If your project does not emit `deployment_status`, do not bend your pipeline to fit the sample: make the same call from whatever step already knows a preview is live - a deploy job, a post-deploy script, your host's own webhook.

```yaml
# .github/workflows/autonoma-preview.yml
name: Autonoma preview signal

on:
  deployment_status:

jobs:
  notify:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - name: Notify Autonoma
        env:
          AUTONOMA_SHARED_SECRET: ${{ secrets.AUTONOMA_SHARED_SECRET }}
          AUTONOMA_ENDPOINT: https://api.autonoma.app/v1/onboarding/deployment-signal
          AUTONOMA_APPLICATION_ID: your-application-id
          PREVIEW_URL: ${{ github.event.deployment_status.target_url }}
          PREVIEW_SHA: ${{ github.event.deployment.sha || github.sha }}
        run: |
          BODY=$(jq -nc \
            --arg applicationId "$AUTONOMA_APPLICATION_ID" \
            --arg previewUrl "$PREVIEW_URL" \
            --arg sha "$PREVIEW_SHA" \
            --arg provider "custom" \
            '{applicationId:$applicationId,previewUrl:$previewUrl,provider:$provider}
              + (if $sha == "" then {} else {sha:$sha} end)')
          SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$AUTONOMA_SHARED_SECRET" -hex | sed 's/^.* //')
          curl -sS -X POST "$AUTONOMA_ENDPOINT" \
            -H "content-type: application/json" \
            -H "x-signature: $SIG" \
            --data "$BODY"
```

Copy it from the onboarding step rather than from here - that copy has your real `applicationId` filled in.

Note what this sample does **not** send: `branch` and `prNumber`. As written it records a preview URL but never asks for a pull-request review. Adding them is the main edit most projects make - on a pull-request deploy, look the PR up (`gh api` from the workflow, or whatever your pipeline already knows) and send both.

Put the secret in your pipeline's secret store rather than committing it:

```bash
gh secret set AUTONOMA_SHARED_SECRET
```

## Verifying it works

![The Connect your deploys onboarding step. A row of provider tiles - Vercel (connect project), Custom (webhook, selected), Netlify and Render (both marked soon). Below, a "What the workflow does" panel explains that Autonoma needs one signed HTTP call whenever a preview goes live and that the sample workflow hangs off GitHub's deployment_status event as one way to make it. Under that, a five-step strip reads: 01 You push, 02 Your CI deploys, 03 A preview goes live, 04 Your pipeline signals, 05 Autonoma tests. Pinned along the bottom, a bar reads "Waiting for your first signal - nothing has reached the deployment signal endpoint yet" beside a disabled "Continue to verify" button](/img/preview-environments/connect-your-deploys.png)

The onboarding step waits for your first real signal and unlocks **Continue** only once one arrives. That gate is deliberate: a signal is the only proof the wiring works.

Prove it with an actual run of your pipeline - push the branch and let it deploy. A hand-written `curl` proves your `curl` works, not that your pipeline calls us.

Watch for two separate milestones:

1. **A signal landed.** The wiring is correct and Autonoma has a preview URL.
2. **A signal carried a `prNumber`.** Until this happens, your app records preview URLs but no pull request is ever reviewed - which is the thing you are actually here for. A main-branch signal alone is not a finished integration.

## Do it with a coding agent

Your agent can do all of this - read how your pipeline actually deploys, write the call into the right step, open a pull request, and poll Autonoma until it sees a real signal land. Run the command Autonoma gives you during onboarding; it starts your agent on the job. See [set up a preview with a coding agent](/mcp/configure-preview).

See [Set up a preview with a coding agent](/mcp/configure-preview/) for the install and the tools it uses on this path: `get_signal_setup`, `get_signal_status`, `confirm_signal_setup`, and `finish_onboarding` to take the app live.

## After the preview is connected

From here the two paths converge. Autonoma has a URL, and the rest of onboarding is identical:

- [Environment Factory](/environment-factory/) - the `/api/autonoma` endpoint that creates and tears down each test's data
- [Scenario recipes](/reference/scenario-recipe-schema/) - the JSON your handler follows to build that data

## Troubleshooting

**Every call comes back rejected.** The signature is over the raw bytes you POST. If you build the body, sign it, and then re-serialize it before sending, the digest no longer matches. Sign and send the same string.

**Signals land but no pull request is reviewed.** Your call is not sending `prNumber`. Check `branch` and `prNumber` go together on pull-request deploys.

**A signal was accepted and then nothing happened.** A signal carrying `branch` without `prNumber` is dropped by design. Send both or neither.

**The preview URL points at the wrong service.** More than one deploy in the pull request is signalling. Signal only the app Autonoma should browse.

**Autonoma opens a stale URL.** Every signal overwrites the stored URL, so the last one to arrive wins. If your pipeline signals from several jobs, keep the one that deploys the app under test.
