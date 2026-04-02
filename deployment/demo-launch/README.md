# Demo Launch Deployment Guide

This guide packages the public Autonoma launch around two public surfaces:

- `autonoma.<your-domain>` - the Autonoma product UI
- `demo.autonoma.app` - the controlled sample target app that Autonoma tests publicly

## Architecture

- `apps/ui` on Vercel
- `apps/api` on Render
- Managed Postgres and Redis on Render
- `apps/demo-target` on Vercel at `demo.autonoma.app`

## Deploy The Demo Target

1. Create a Vercel project with root directory `apps/demo-target`.
2. Set the production domain to `demo.autonoma.app`.
3. Use the included `vercel.json` rewrite so deep links resolve to `index.html`.
4. Run:

```bash
pnpm --filter @autonoma/demo-target build
```

## Deploy Autonoma UI

1. Create a second Vercel project with root directory `apps/ui`.
2. Set:

```bash
VITE_API_URL=https://<your-render-api-domain>
VITE_INTERNAL_DOMAIN=autonoma.app
VITE_POSTHOG_KEY=<optional>
VITE_POSTHOG_HOST=<optional>
VITE_SENTRY_DSN=<optional>
```

3. Use the included `apps/ui/vercel.json` rewrite for SPA routing.
4. Run:

```bash
pnpm --filter @autonoma/ui build
```

## Deploy Autonoma API

1. Create Render services from the root `render.yaml`.
2. Set all `sync: false` secrets before enabling public traffic.
3. The blueprint is configured to:
   - build the API with `pnpm --filter @autonoma/api build`
   - run Prisma migrations with `pnpm --filter @autonoma/db exec prisma migrate deploy`
   - start the API with `pnpm --filter @autonoma/api start`
4. Seed the demo data after the API environment is valid:

```bash
pnpm --filter @autonoma/db db:seed
```

## Demo Readiness Checklist

- `demo.autonoma.app` loads publicly
- Login flow works on the demo target
- Products page and product detail pages are reachable
- Add-to-cart flow updates cart count deterministically
- Autonoma “Demo App” points to `https://demo.autonoma.app`
- One natural-language happy-path run completes successfully

## Launch Assets

- record one short clip:
  - open Autonoma
  - select the demo app
  - run a natural-language test
  - show the successful result
- capture one clean screenshot or GIF fallback
- publish using the launch copy in `deployment/demo-launch/x-post.md`
