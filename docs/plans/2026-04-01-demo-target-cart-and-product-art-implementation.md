# Demo Target Cart And Product Art Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add CSS-generated product visuals and real cart interactions to the demo storefront so it behaves more like a production retail site.

**Architecture:** Expand the product model to carry a visual variant and numeric price metadata, then replace the count-only cart state with product-backed cart line items in `src/app.tsx`. Update `src/styles.css` so each product visual variant renders distinct CSS artwork and the cart UI supports quantities, remove actions, and empty-state handling.

**Tech Stack:** React, TypeScript, Vite, CSS

---

### Task 1: Expand the product and cart data model

**Files:**
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/app.tsx`

**Step 1:** Add numeric pricing and a visual variant field to each product.

**Step 2:** Introduce a cart item model that stores product slug and quantity.

**Step 3:** Derive cart count and cart line items from that new state.

### Task 2: Wire real cart interactions

**Files:**
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/app.tsx`

**Step 1:** Make “Add to Cart” add the active product instead of incrementing a bare count.

**Step 2:** Add quantity increment, decrement, and remove handlers.

**Step 3:** Render cart subtotal, shipping, total, and an empty-cart state.

### Task 3: Add CSS-generated product art

**Files:**
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/app.tsx`
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/styles.css`

**Step 1:** Add reusable product visual markup tied to the product variant.

**Step 2:** Style each visual variant so the three products feel distinct.

**Step 3:** Reuse the visuals in the grid, hero, and detail views.

### Task 4: Verify the storefront

**Files:**
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/app.tsx`
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/styles.css`

**Step 1:** Run `pnpm --filter @autonoma/demo-target typecheck`.

**Step 2:** Run `pnpm --filter @autonoma/demo-target build`.

**Step 3:** Fix any issues and rerun until both commands pass.
