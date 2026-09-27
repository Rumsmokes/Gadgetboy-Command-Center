# Technician QR Payment Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Collected Today into an exact payment-event drill-down and require an attributed technician PIN workflow for every staff QR scan.

**Architecture:** Extend the payment-ledger projection in `commandCenter.ts` and render it from the existing Command Center tile. Keep Supabase staff authentication, issue a server-validated QR-tab technician session after PIN entry, and make that identity mandatory for QR update writes so history, ticket routing, and statistics use the same events.

**Tech Stack:** React, TypeScript, Electron, Vite, Supabase Postgres/Edge Functions, Node assertion tests, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-27-technician-qr-payment-audit-design.md`

## Global Constraints

- Keep **Collected Today** as the Command Center tile; clicking it opens the transaction log.
- A technician PIN is required on every new staff QR scan/tab.
- Existing Supabase staff authentication remains required; public client pages remain token-scoped and cannot access the POS.
- Statistics begin on `2026-09-27`; diagnostic/additional fees, historic records, and not-repairable tickets remain excluded.
- Never expose PINs, auth tokens, or customer secrets in UI, tests, or logs.
- Ship `0.1.21` with Windows installer/update feed, Android APK, and instructions PDF.

## Review Focus

- Two partial payments for one invoice must remain two distinct log rows and sum once — Task 1.
- A historical correction recorded today must not become today’s checkout collection — Task 1.
- Invalid PIN must never unlock staff QR controls or mutate a ticket — Task 2.
- Client public links must never display staff controls or self-close — Task 2.
- Valid QR transitions must update timestamps that routing and statistics consume — Task 3.

---

### Task 1: Collected Today payment-event model and panel

**Files:**
- Modify: `src/lib/commandCenter.ts`
- Modify: `src/components/CommandCenter.tsx`
- Create: `tools/test-collected-today-transaction-log.cjs`

**Interfaces:**
- Produce `CollectedTodayTransaction` with `id`, `recordedAt`, `invoiceLabel`, `recordKind`, `recordId`, `clientLabel`, `summary`, `paymentType`, `paymentMethod`, and `amount`.
- Add `collectedTodayTransactions: CollectedTodayTransaction[]` to `CommandCenterModel`.

- [ ] **Step 1: Write failing ledger projection test.** Create two same-day payment events (`Diagnostic fee` for `$25`, `Final repair payment` for `$70`) under `WO #44`; assert total `$95`, two rows newest-first, and each row has invoice/client/payment data. Add a duplicate event ID and assert it does not add a third row. Add a same-day record with only `amountPaid` and assert no payment-log row exists.
- [ ] **Step 2: Run `node tools/test-collected-today-transaction-log.cjs`.** Confirm failure because the model has no transaction projection.
- [ ] **Step 3: Implement `CollectedTodayTransaction` and `collectedTodayTransactions(records, now)` in `src/lib/commandCenter.ts`.** Reuse `paymentLedgerFor`, `paymentRecordedAt`, `collectedPaymentAmount`, and `paymentEventKey`; filter local-current-day event timestamps; de-duplicate by existing event key; map `WO #id` or `Sale #id`; label missing client as `Quick checkout`; sort descending by `recordedAt`.
- [ ] **Step 4: Replace the Collected Today click handler in `CommandCenter.tsx` with `setPanel({ title: 'Today’s Payment Log', kind: 'payment-log' })`.** Render a responsive panel list showing local date/time, invoice, client, concise summary, payment type/method, and amount. Preserve tile total, count, and Clover tooltip.
- [ ] **Step 5: Run `node tools/test-collected-today-transaction-log.cjs` and `node tools/test-collected-today-ledger.cjs`; both must pass.**
- [ ] **Step 6: Commit `src/lib/commandCenter.ts`, `src/components/CommandCenter.tsx`, and test as `feat: add collected today payment log`.**

### Task 2: Mandatory per-scan QR technician PIN

**Files:**
- Create: `supabase/migrations/20260927000000_qr_technician_attribution.sql`
- Modify: `supabase/functions/qr-status/index.ts`
- Modify: `supabase/functions/client-updates/index.ts`
- Create: `tools/test-qr-technician-pin.cjs`

**Interfaces:**
- Create `qr_technician_sessions(id, shop_id, qr_token_id, staff_profile_id, legacy_technician_id, expires_at, revoked_at, created_at)`.
- Add `technician_session_token` to staff QR client-update request payloads.
- Add `technician_id` and `technician_name` columns to `client_update_history`.

- [ ] **Step 1: Write failing static/runtime test.** Assert staff QR HTML contains `Enter your technician PIN before continuing`, a `verify-pin` POST route, and no client page contains staff PIN/control text. Assert migration contains QR session table and technician history fields; assert update function requires `technician_session_token` for QR-originated staff actions.
- [ ] **Step 2: Run `node tools/test-qr-technician-pin.cjs`.** Confirm failure before implementation.
- [ ] **Step 3: Create migration.** Enable RLS on `qr_technician_sessions`, revoke access from `anon` and `authenticated`, index active lookup by `shop_id`, `qr_token_id`, and `expires_at`, and add nullable technician history columns plus index. Edge function service-role access is the only PIN read path.
- [ ] **Step 4: Add QR staff PIN gate in `qr-status/index.ts`.** Retain `auth.getUser()` for staff routes. Render a PIN-only page before QR controls. Add POST verification that matches an active shop technician credential, creates a 10-minute QR-token-scoped opaque session, and returns no PIN. Keep token only in the tab script memory; do not use query parameters or cross-tab storage.
- [ ] **Step 5: Verify session in `client-updates/index.ts` before every QR staff mutation.** Reject missing, expired, wrong-shop, or wrong-token sessions; add verified technician legacy ID/name to each history row. Keep desktop non-QR workflows compatible without inventing a technician identity.
- [ ] **Step 6: Add staff-email confirmation countdown.** After successful client email only, display `Email sent. This tab will close in 5 seconds`, decrement each second, call `window.close()` at zero, and include `Close now`. Do not add it to internal-only, failed, or public client flows.
- [ ] **Step 7: Run `node tools/test-qr-technician-pin.cjs` and `node tools/test-supabase-client-updates.cjs`; both must pass.**
- [ ] **Step 8: Commit migration, functions, and test as `feat: require technician PIN for QR updates`.**

### Task 3: Technician-attributed routing and clean repair statistics

**Files:**
- Modify: `supabase/functions/client-updates/index.ts`
- Modify: `src/workorders/ClientUpdatePanel.tsx`
- Modify: `src/lib/repairStatistics.ts`
- Modify: `app/electron/electron-main.ts`
- Create: `tools/test-qr-repair-statistics.cjs`

**Interfaces:**
- Uses existing `diagnosisStartedAt`, `testingStartedAt`, `repairCompletionDate`, `lastTechnicianActivityAt`, and cloud mappings.
- Sets `REPAIR_STATISTICS_BASELINE = '2026-09-27T04:00:00.000Z'`.

- [ ] **Step 1: Write failing test.** A dated `diagnosisStartedAt → testingStartedAt → repairCompletionDate` with substantive repair item must produce one sample. Equivalent not-repairable, pre-baseline, diagnostic-only, and fee-only fixtures must produce zero samples.
- [ ] **Step 2: Run `node tools/test-qr-repair-statistics.cjs`.** Confirm baseline/timestamp behavior is incomplete.
- [ ] **Step 3: Update QR transition mapping in `client-updates/index.ts`.** `diagnosis_in_progress` sets missing diagnosis start; `testing_in_progress` sets missing testing start; `repair_completed` sets completion time; every valid action sets last technician activity. `repair_not_possible` routes to pickup without completion time. Preserve current status fields so Command Center stage calculation responds immediately.
- [ ] **Step 4: Ensure Electron cloud `fromCloudRow`/`toCloudRow` preserve all workflow timestamps and technician-update metadata.** Do not let stale cloud values overwrite later terminal workflow state.
- [ ] **Step 5: In `ClientUpdatePanel.tsx`, display `Logged by {technician_name}` in the correct existing Client Updates or Tech Notes history section.** Keep technician-only notes out of client update history.
- [ ] **Step 6: Set the new baseline in `repairStatistics.ts` and retain the existing fee exclusion filter.**
- [ ] **Step 7: Run `node tools/test-qr-repair-statistics.cjs`, `node tools/test-repair-statistics.cjs`, and `node tools/test-command-center-routing.cjs`; all must pass.**
- [ ] **Step 8: Commit as `feat: attribute QR workflow and repair statistics`.**

### Task 4: Version, package, and publish v0.1.21

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Set package version to `0.1.21` and add changelog entries for payment log, per-scan PIN, attributed history/statistics, and staff QR email-tab close.**
- [ ] **Step 2: Run `npm run typecheck`, `npm run build`, `node tools/test-collected-today-ledger.cjs`, `node tools/test-collected-today-transaction-log.cjs`, `node tools/test-qr-technician-pin.cjs`, `node tools/test-qr-repair-statistics.cjs`, and `npm run test:client-update-api`.** All must pass.
- [ ] **Step 3: Commit version files as `release: v0.1.21`, tag `v0.1.21`, and push branch/tag.**
- [ ] **Step 4: Verify the successful GitHub release has `GB-POS-installerx64-0.1.21.exe`, matching `.blockmap`, `latest.yml`, `Android-APK-universal-0.1.21.apk`, and `GadgetBoy-POS-Instructions-0.1.21.pdf`.**

## Self-Review

- Task 1 covers the tile total plus detailed ledger log.
- Task 2 covers mandatory PIN, server validation, attribution storage, and QR email tab cleanup.
- Task 3 covers timestamp routing, history display, and fresh repair learning.
- Task 4 covers full multi-platform release assets.
- No task relies on an undefined interface or placeholder implementation.
