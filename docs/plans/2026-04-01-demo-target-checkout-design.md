# Demo Target Checkout Design

## Summary

Add a deterministic demo checkout flow to the storefront so the shopping experience can progress from cart review to a believable order confirmation without any backend dependency.

## Goals

- Add a dedicated checkout route.
- Keep the flow simple and retail-like:
  - cart
  - checkout form
  - place order
  - success state
- Clear the cart after a successful order.
- Preserve a stable, demo-friendly experience with prefilled values and no external payment processing.

## Behavior

- The cart page should route to `/checkout`.
- The checkout page should include:
  - contact email
  - full name
  - shipping address
  - city/state/ZIP
  - delivery method
  - payment summary section
- Fields should be prefilled with demo values.
- Submitting the form should:
  - capture a small confirmation payload
  - clear the cart
  - show a success/confirmation state

## Constraints

- No backend requests.
- No real payments.
- Keep the labels and flow obvious enough for demos and natural-language prompts.
