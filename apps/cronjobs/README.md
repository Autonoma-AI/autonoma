# Cronjobs

Scheduled tasks that run periodically for background maintenance and billing operations. These are standalone scripts designed to be executed by a cron scheduler (e.g., Kubernetes CronJobs, GitHub Actions scheduled workflows, or cron daemon).

## Available Cronjobs

| Script | Purpose | Schedule |
|--------|---------|----------|
| `vercel-billing-invoicer` | Creates and submits invoices to Vercel for (a) `pending` periods seeded by the legacy installation migration and (b) `active` periods whose cycle ends today, including a pay-per-usage overage line item when the plan has `overagePricePerCredit` set. Rolls (a) into `active`; closes out (b) as `completed` and creates the next period as `active`. | Daily (00:00 UTC) |
| `vercel-usage-reporter` | Reports daily usage metrics (test runs, test generations) to Vercel billing API for all active installations. | Daily (01:00 UTC) |
| `preview-usage-meter` | Closes wall-clock-aligned 15-minute previewkit compute-usage windows from the self-hosted Prometheus and deducts the corresponding credits. See `@autonoma/billing`'s `preview-usage-meter/` for the sweep/Prometheus-client implementation. | Every 15 minutes |
| `aws-compute-pricing-drift` | Fetches live AWS pricing for the buildkit/previewkit Karpenter pools' reference instance types (blended by buildkit's real recent spot/on-demand mix), upserts it into the global `ComputePricingReference` table, and pages (Sentry, "warning") when it drifts >10% from what was stored last run. Writes only that reference table - a human decides whether to update any org's `BillingPricing` via `admin.billing.updateComputePricing` (see `@autonoma/billing`'s `aws-pricing/` for the derivation math and the manual `derive-compute-pricing-cli.ts`). | Weekly (Mon 03:00 UTC) |

## Running Locally

```bash
# From monorepo root
pnpm --filter @autonoma/cronjobs billing-invoicer
pnpm --filter @autonoma/cronjobs usage-reporter
pnpm --filter @autonoma/cronjobs usage-meter
pnpm --filter @autonoma/cronjobs aws-compute-pricing-drift

# Or from apps/cronjobs directory
pnpm billing-invoicer
pnpm usage-reporter
pnpm usage-meter
pnpm aws-compute-pricing-drift
```

## Environment Variables

Every cronjob needs (`scripts/env.ts`):
- `DATABASE_URL` - PostgreSQL connection string (from `@autonoma/db`)
- `SENTRY_DSN` - Sentry DSN for error tracking (from `@autonoma/logger`)
- `NODE_ENV` - Environment (default: `development`)

Anything else belongs to a single job, declared in that job's own env module so its manifest carries only the secrets it uses.

`vercel-billing-invoicer` and `vercel-usage-reporter` (`scripts/vercel-env.ts`):
- `VERCEL_ENCRYPTION_KEY` - 64-char hex key used to decrypt `VercelInstallation.accessTokenEnc` (must match the key `apps/api` uses to encrypt it)

`preview-usage-meter` (`scripts/preview-usage-meter/env.ts`):
- `PROMETHEUS_URL` - defaults to `https://prometheus.autonoma.app:9090`, the self-hosted Prometheus both clusters remote_write to (`deployment/prometheus-agent/README.md`)
- `PROMETHEUS_USERNAME` / `PROMETHEUS_PASSWORD` - HTTP basic auth for `/api/v1/query`; in-cluster these come from the `prometheus-basic-auth` Secret in the `cronjob` namespace (see `deployment/cronjob/preview-usage-meter.yaml`)

`aws-compute-pricing-drift` needs no job-specific env vars, but its ServiceAccount needs an IRSA-bound
IAM role granting `pricing:GetProducts` (on-demand pricing) and `ec2:DescribeSpotPriceHistory` (spot
pricing for the buildkit pool) - neither supports resource-level scoping - see the
`eks.amazonaws.com/role-arn` annotation in `deployment/cronjob/aws-compute-pricing-drift.yaml`. It also
reads (never writes) Postgres for the recent build capacity-type mix used to blend buildkit's rate.

## Deployment

These scripts are designed to run as Kubernetes CronJobs. The multi-stage Dockerfile
bundles each script with Rolldown (`rolldown.config.ts`) into a self-contained
`dist/<script>.js` (all deps inlined) in a builder stage, then the runtime image
(Node 24 Alpine, with OpenSSL installed for Prisma's query engine) ships only
`dist/` - no `node_modules`, no tsx - running as the unprivileged `node` user. The
image has no default job - the CronJob manifest's `command:` must select the
bundled script to run:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: vercel-billing-invoicer
spec:
  schedule: "0 0 * * *"  # Daily at midnight UTC
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: billing-invoicer
            image: autonoma/cronjobs:latest
            command: ["node", "--enable-source-maps", "dist/billing-invoicer.js"]
            env:
              - name: DATABASE_URL
                valueFrom:
                  secretKeyRef:
                    name: db-credentials
                    key: url
```

## Architecture Notes

- **Idempotent by design:** Each cronjob checks for pending work (e.g., billing periods with status `pending`) to avoid duplicate processing. `aws-compute-pricing-drift` is idempotent by construction - each run just upserts the one reference row per pool.
- **Sentry integration:** Uses Sentry Cron Monitoring (`captureCheckIn`) to track execution status and send alerts on failure.
- **Logging:** Structured logging via `@autonoma/logger` with Sentry integration.
- **Graceful shutdown:** Disconnects from database before exit.
