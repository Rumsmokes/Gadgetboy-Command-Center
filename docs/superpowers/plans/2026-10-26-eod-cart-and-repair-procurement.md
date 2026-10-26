# EOD Cart and Repair Procurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep in-stock repair parts out of EOD, preserve exact inventory-variant consumption, and expose Checkout Cart from mobile Command Center.

**Architecture:** Procurement eligibility is centralized in `orderAccounting.ts`; UI line creation records an explicit source rather than deriving it from a URL. The existing inventory consumption path continues to select a child variant from a linked parent and is tightened to reject mismatched or ambiguous children. Mobile uses the existing EOD window and gains a direct Command Center action.

**Tech Stack:** React, TypeScript, Electron/Capacitor, Node contract tests.

**Spec:** `docs/superpowers/specs/2026-10-26-eod-cart-and-repair-procurement.md`

## Global Constraints

- Do not change or delete historical source records solely to remove an incorrect cart row.
- MOQ reorders remain manual inventory purchases.
- Preserve current purchase-cart delivery, reporting, and customer-update behavior for explicitly ordered items.

## Review Focus

- Legacy repair rows with an order URL but no explicit order source must stay out of EOD when in stock.
- Ordered rows with stale `in_stock` status must remain in EOD.
- Parent inventory groups must not be consumed as a repair part.
- The mobile action must open the production EOD window, not a placeholder panel.
- Client-provided, salvaged, labor, diagnostic, and fee lines cannot re-enter EOD.

### Task 1: Procurement eligibility contract

**Files:**
- Modify: `src/lib/orderAccounting.ts`
- Modify: `tools/test-order-accounting.cjs`

- [ ] Add failing contract tests for explicit supplier orders, in-stock linked repairs with URLs, and non-purchasable repair sources.
- [ ] Centralize explicit procurement eligibility and use it in cart collection.
- [ ] Run `npm run test:order-accounting`.

### Task 2: Repair-line source and inventory safety

**Files:**
- Modify: `src/workorders/ItemsTable.tsx`
- Modify: `src/lib/inventoryConsumption.ts`
- Modify: `tools/test-inventory-consumption.cjs`

- [ ] Add failing tests covering exact PS5 child consumption and ordered/in-stock line behavior.
- [ ] Record explicit in-stock/order source when a saved repair is added and consume only explicit in-stock variants.
- [ ] Run `npm run test:inventory-consumption` and `npm run test:inventory-repair-matching`.

### Task 3: Mobile Command Center cart access

**Files:**
- Modify: `src/components/CommandCenter.tsx`
- Modify: `src/mobile/MobileApp.tsx`
- Modify: `tools/test-mobile-command-center.cjs`

- [ ] Add a failing UI contract for the mobile EOD/Checkout Cart action.
- [ ] Add the action using the existing EOD modal route and include the cart count.
- [ ] Run `npm run test:mobile-command-center`.

### Task 4: Release verification

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] Bump version and add release notes.
- [ ] Run all targeted contracts plus `npm run typecheck` and `npm run build`.
- [ ] Publish the release with Windows and Android artifacts.
