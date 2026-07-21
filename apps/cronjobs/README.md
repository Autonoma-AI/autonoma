# Cronjobs

Scheduled tasks that run periodically for background maintenance and billing operations. These are standalone scripts designed to be executed by a cron scheduler (e.g., Kubernetes CronJobs, GitHub Actions scheduled workflows, or cron daemon).

## Available Cronjobs

| Script | Purpose | Schedule |
|--------|---------|----------|
| `vercel-billing-invoicer` | Creates and submits invoices to Vercel for pending billing periods. Marks periods as active and creates next billing period. | Daily (00:00 UTC) |
| `vercel-usage-reporter` | Reports daily usage metrics (test runs, test generations) to Vercel billing API for all active installations. | Daily (01:00 UTC) |
| `preview-usage-meter` | Closes wall-clock-aligned 15-minute previewkit compute-usage windows from AMP (Amazon Managed Prometheus) and deducts the corresponding credits. See `@autonoma/billing`'s `preview-usage-meter/` for the sweep/AMP-client implementation. | Every 15 minutes |

## Running Locally

```bash
# From monorepo root
pnpm --filter @autonoma/cronjobs billing-invoicer
pnpm --filter @autonoma/cronjobs usage-reporter
pnpm --filter @autonoma/cronjobs usage-meter

# Or from apps/cronjobs directory
pnpm billing-invoicer
pnpm usage-reporter
pnpm usage-meter
```

## Environment Variables

These cronjobs rely on:
- `DATABASE_URL` - PostgreSQL connection string (from `@autonoma/db`)
- `VERCEL_ENCRYPTION_KEY` - 64-char hex key used to decrypt `VercelInstallation.accessTokenEnc` (must match the key `apps/api` uses to encrypt it)
- `SENTRY_DSN` - Sentry DSN for error tracking (from `@autonoma/logger`)
- `NODE_ENV` - Environment (default: `development`)
- `AMP_WORKSPACE_URL` / `AMP_REGION` - only used by `preview-usage-meter`; default to the shared production AMP workspace (`deployment/amp/README.md`). The sweep signs requests with SigV4 via the default AWS credential provider chain (EKS Pod Identity in-cluster) - its ServiceAccount's IAM role needs `aps:QueryMetrics` on the workspace ARN, granted out-of-band (see `deployment/cronjob/preview-usage-meter.yaml`).

## Deployment

These scripts are designed to run as Kubernetes CronJobs:

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
            command: ["pnpm", "billing-invoicer"]
            env:
              - name: DATABASE_URL
                valueFrom:
                  secretKeyRef:
                    name: db-credentials
                    key: url
```

## Architecture Notes

- **Idempotent by design:** Each cronjob checks for pending work (e.g., billing periods with status `pending`) to avoid duplicate processing.
- **Sentry integration:** Uses Sentry Cron Monitoring (`captureCheckIn`) to track execution status and send alerts on failure.
- **Logging:** Structured logging via `@autonoma/logger` with Sentry integration.
- **Graceful shutdown:** Disconnects from database before exit.
