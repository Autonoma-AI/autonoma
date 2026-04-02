# Demo Target Checkout Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a demo checkout page and order-confirmation state to the storefront so the cart flow feels complete without introducing backend dependencies.

**Architecture:** Extend the existing route map with a checkout route and introduce a lightweight order confirmation object in `src/app.tsx`. Reuse the current cart totals, add a prefilled checkout form, and render a success state after submit while clearing the cart.

**Tech Stack:** React, TypeScript, Vite, CSS

---

### Task 1: Extend checkout state and routing

**Files:**
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/app.tsx`

**Step 1:** Add a checkout route constant.

**Step 2:** Add a small order confirmation model to hold order number, contact, and total.

**Step 3:** Wire the cart page CTA to navigate to checkout.

### Task 2: Build the checkout page

**Files:**
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/app.tsx`
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/styles.css`

**Step 1:** Add a prefilled shipping/contact form.

**Step 2:** Add a matching order summary panel with the current totals.

**Step 3:** On submit, create a demo order confirmation, clear the cart, and show a success state.

### Task 3: Verify the flow

**Files:**
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/app.tsx`
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/styles.css`

**Step 1:** Run `pnpm --filter @autonoma/demo-target typecheck`.

**Step 2:** Run `pnpm --filter @autonoma/demo-target build`.

**Step 3:** Fix any issues and rerun until both commands pass.
