# @autonoma/demo-target

Public sample web app used as the controlled target for Autonoma demos and launch videos.

## Purpose

This app is intentionally simple and stable. It exists to provide a deterministic web surface that Autonoma can test publicly without depending on an external product.

The demo target includes:

- Homepage
- Login page
- Products listing
- Product detail page
- Add-to-cart flow

## Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @autonoma/demo-target dev
```

## Production target

This app is designed to be hosted at `https://demo.autonoma.app`.
