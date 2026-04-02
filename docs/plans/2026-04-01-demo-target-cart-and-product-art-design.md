# Demo Target Cart And Product Art Design

## Summary

Upgrade the storefront so products feel more tangible and the cart behaves like a real retail cart. Keep the site deterministic and fully local by generating product visuals in CSS instead of introducing image assets.

## Goals

- Make each product feel distinct through custom visual treatment.
- Replace the cart-count-only state with real cart items keyed to products.
- Support common retail interactions:
  - add to cart
  - increase quantity
  - decrease quantity
  - remove item
  - empty-cart state
- Preserve straightforward labels and predictable behavior for demos.

## Visual Direction

- Keep the dark electronics-retail look.
- Give each product a unique visual composition using gradients, rings, bars, or silhouette-like geometry.
- Reuse those visuals in the product grid, hero panel, and product detail page.

## Cart Behavior

- Cart state should be an array of line items or an equivalent keyed model.
- Cart count in the header should derive from total quantity.
- “Add to Cart” on product detail pages should add the selected product.
- Cart page should show:
  - line items
  - quantity controls
  - remove action
  - subtotal
  - shipping
  - total
- If the cart is empty, show a proper empty-cart panel with a return-to-products CTA.

## Constraints

- No external assets or APIs.
- Keep the app as a single client-side React/Vite storefront.
- Maintain mobile responsiveness.
