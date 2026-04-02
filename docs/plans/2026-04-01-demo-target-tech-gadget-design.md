# Demo Target Tech Gadget Storefront Design

## Summary

Redesign `apps/demo-target` from a launch placeholder into a believable consumer electronics storefront. The experience should feel like a premium gadget retail website while preserving the stable, deterministic paths needed for Autonoma demos.

## Goals

- Make the storefront feel like a real public website instead of an internal demo page.
- Preserve the happy-path routes required for demos:
  - `/`
  - `/login`
  - `/products`
  - `/products/:slug`
  - `/cart`
- Improve visual polish and commerce realism without introducing external dependencies.

## Experience Direction

- Visual language: dark graphite and near-black surfaces with electric cyan and blue accents.
- Product framing: spec-driven cards, shipping/status chips, and featured-product merchandising.
- Tone: confident, retail-forward, and consumer-facing rather than explaining the app as a demo target.
- Interaction: simple, readable navigation and stable labels for testing.

## Page Design

### Home

- Replace the placeholder hero copy with a real storefront hero and featured product promotion.
- Add supporting retail sections such as:
  - category highlights
  - featured products
  - trust metrics or service promises
  - promo/support strip

### Products

- Present products as a proper gadget catalog with richer cards.
- Include category, key specs, shipping/status labels, and realistic commerce CTAs.

### Product Detail

- Focus on specs and purchase confidence:
  - product headline
  - technical highlights
  - availability/shipping details
  - add-to-cart CTA

### Login and Cart

- Keep both flows straightforward for testability.
- Restyle them to match the darker storefront aesthetic.

## Content Strategy

- Keep the copy stable and deterministic.
- Use realistic gadget descriptions instead of meta-demo language.
- Preserve obvious labels so natural-language prompts remain effective.

## Constraints

- No backend or API dependency.
- No external product images required.
- Keep the implementation in the existing single-page React/Vite app.
- Maintain mobile responsiveness.
