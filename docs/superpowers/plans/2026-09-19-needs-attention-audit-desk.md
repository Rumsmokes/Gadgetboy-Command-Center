# Needs Attention Audit Desk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Needs Attention into a live, grouped audit desk for in-scope POS records and package it with the completed form-entry improvements.

**Architecture:** `commandCenter.ts` remains the source of record and lifecycle state. A presentation mapper derives audit entries, grouping, priority, and actions; `CommandCenter.tsx` renders that projection as the approved responsive window.

**Tech Stack:** React, TypeScript, Command Center model, Node assertion scripts, Electron/Vite renderer.

**Spec:** `docs/superpowers/specs/2026-09-19-needs-attention-audit-design.md`

## Global Constraints

- Needs Attention includes only invoices created on or after September 1, 2026.
- Older invoices remain in history/reporting and are excluded regardless of state.
- Future ETA and scheduled pickup continue to suppress false stale alerts.
- Audit actions open existing workflows and never silently change financial or ticket state.
- Desktop and mobile rows must remain readable without horizontal overflow.

## Review Focus

- September 1 includes, August 31 excludes; covered in Task 1.
- A ticket with multiple issues remains one visible entry with all reasons; covered in Task 1.
- Future ETA and scheduled pickup do not create stale-work alerts; covered in Task 1.
- Missing technician assignment routes back to the existing record; covered in Task 2.
- Refresh removes resolved alerts; covered in Task 2.

---

### Task 1: Audit entry projection

**Files:** `src/lib/commandCenterPresentation.ts`, `tools/test-command-center-repair-details.cjs`, `tools/test-command-center-workflow.cjs`.

**Produces:** `buildAttentionAudit(records, options)`, returning entries, metrics, and groups. An entry contains the original record, all reasons, group, priority, supporting detail, and safe action code.

- [ ] Write failing tests that pass pre-cutoff, cutoff, and multiple-reason records into `buildAttentionAudit`; assert August 31 is absent, September 1 is present, and two reasons remain attached to one entry.
- [ ] Run `node tools/test-command-center-repair-details.cjs`; confirm failure because `buildAttentionAudit` is absent.
- [ ] Implement a minimal pure mapper. It filters `record.source.createdAt || record.source.date || record.activityAt` against `2026-09-01T00:00:00`, preserves all attention reasons on one entry, maps codes to Urgent follow-up, Money & inventory review, or Client communication & ticket details, and calculates metrics from in-scope records.
- [ ] Run `node tools/test-command-center-repair-details.cjs; node tools/test-command-center-workflow.cjs; node tools/test-work-order-lifecycle.cjs`; confirm all pass, including future-ETA and scheduled-pickup coverage.
- [ ] Commit only the mapper and its tests with message `feat: project grouped needs attention audit entries`.

### Task 2: Live Needs Attention audit window

**Files:** `src/components/CommandCenter.tsx`, `src/styles/command-center.css`, `tools/test-command-center-live-runtime.cjs`.

**Consumes:** `buildAttentionAudit(model.needsAttention)` and existing record opening, reply, hover, long-press, and context-menu handlers.

**Produces:** a responsive live panel with grouped rows, filters, metrics, direct Fix routing, and refreshed projection.

- [ ] Write failing live renderer tests that open Needs Attention, find `[data-testid="attention-audit"]`, find three `[data-testid="attention-group"]` sections, and verify a known action label such as `Review pickup`.
- [ ] Run `node tools/test-command-center-live-runtime.cjs`; confirm failure because the grouped audit panel does not exist.
- [ ] Render the approved audit header, filters, metrics, and group rows. The Fix handler uses the existing record opening path, client-reply path, pickup workflow, or record menu; unknown actions fall back to opening the record.
- [ ] Add the responsive grid: desktop has stripe, record, reason, status/balance, and fix columns; mobile collapses to stripe, detail, and fix columns with no horizontal overflow.
- [ ] Run `node tools/test-command-center-live-runtime.cjs; npm run typecheck:renderer`; confirm both pass.
- [ ] Commit only the window, CSS, and live test with message `feat: render grouped needs attention audit desk`.

### Task 3: Release readiness for current form changes

**Files:** verify `src/workorders/NewWorkOrderWindow.tsx`, `src/workorders/CheckoutWindow.tsx`, `src/sales/SaleWindow.tsx`, `src/workorders/WorkOrderItemDialog.tsx`, `src/sales/SaleItemDialog.tsx`; extend `tools/test-ticket-catalog-pickers.cjs` only where regression coverage is missing.

**Produces:** verified behavior for context-sensitive validation, catalog/custom-item dialogs, top-level sale assignment, unchecked receipt defaults, and first-payment form printing.

- [ ] Add or confirm assertions for `SaleTechnicianField`, receipt default false, `initialCheckoutReleaseForm`, and `initialSaleCheckoutForm`.
- [ ] Run `node tools/test-ticket-catalog-pickers.cjs`; if it finds a regression, correct only the existing handler responsible for that behavior and rerun.
- [ ] Run `node tools/test-ticket-catalog-pickers.cjs; node tools/test-command-center-repair-details.cjs; node tools/test-command-center-workflow.cjs; node tools/test-command-center-live-runtime.cjs; npm run typecheck:renderer`; confirm all pass.
- [ ] Commit the verified existing form changes and package the release using the project's documented release command.
