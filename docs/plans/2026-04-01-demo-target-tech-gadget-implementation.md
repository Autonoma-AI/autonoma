# Demo Target Tech Gadget Storefront Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform `apps/demo-target` into a darker, spec-driven gadget storefront that feels like a real e-commerce site while preserving stable demo flows.

**Architecture:** Keep the existing client-side route switching model, but replace the placeholder marketing layout with a retail-oriented storefront structure. Update the content model in `src/app.tsx` and rebuild the visual system in `src/styles.css` so the same routes feel like a cohesive commerce experience.

**Tech Stack:** React, TypeScript, Vite, CSS

---

### Task 1: Expand the storefront content model

**Files:**
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/app.tsx`

**Step 1:** Replace the minimal product data with richer gadget-oriented metadata such as specs, shipping, and support text.

**Step 2:** Add helper data for homepage sections such as category highlights, trust metrics, or service promises.

**Step 3:** Keep route behavior unchanged so existing demo flows still work.

### Task 2: Redesign the page structure

**Files:**
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/app.tsx`

**Step 1:** Rework the home page into a real storefront landing page with hero, featured products, and support sections.

**Step 2:** Rework the products page into a richer catalog layout.

**Step 3:** Rework the product detail, login, and cart pages to match the new retail direction.

### Task 3: Rebuild the visual system

**Files:**
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/styles.css`

**Step 1:** Replace the light placeholder styling with a darker electronics-retail visual system.

**Step 2:** Add layout, spacing, and responsive styling for the new sections and cards.

**Step 3:** Ensure the design still reads clearly on mobile and desktop.

### Task 4: Verify the storefront

**Files:**
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/app.tsx`
- Modify: `/Users/adnan/Documents/autonoma/apps/demo-target/src/styles.css`

**Step 1:** Run `pnpm --filter @autonoma/demo-target typecheck`.

**Step 2:** Run `pnpm --filter @autonoma/demo-target build`.

**Step 3:** Fix any issues and rerun until both commands pass.
