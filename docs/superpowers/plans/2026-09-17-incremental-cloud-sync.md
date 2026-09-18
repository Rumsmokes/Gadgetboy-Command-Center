# GB POS Incremental Cloud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace recurring full-history Supabase reads with cache-first incremental synchronization and make Command Center workflow routing deterministic across desktop, mobile, QR updates, checkout, and remote changes.

**Architecture:** Pure shared utilities define cursors, reconciliation timing, event coalescing, and canonical workflow routing. Electron main and the mobile API use those utilities to merge only changed rows into their existing local caches; renderers consume targeted collection events rather than initiating broad reloads. Supabase receives only the indexes needed to support shop-scoped incremental reads.

**Tech Stack:** Electron, React, TypeScript, Supabase JavaScript client, Postgres/RLS, Capacitor Android, Node-based behavior tests.

**Spec:** `docs/superpowers/specs/2026-09-17-incremental-cloud-sync-design.md`

## Global Constraints

- Do not insert test records into production Supabase.
- Do not modify the existing GitHub remote or publish a release during implementation.
- Preserve the existing durable offline write queue and local JSON/localStorage caches.
- Never expose a service-role key or weaken shop-scoped RLS.
- Closed, picked-up, cancelled, voided, deleted, or archived tickets must not reappear in active Command Center sections.
- Today's Repair Queue remains capped at eight in the approved priority order.
- All code edits use test-first red/green cycles.

---

### Task 1: Shared Incremental-Sync Primitives

**Files:**
- Create: `src/lib/incrementalSync.ts`
- Create: `tools/test-incremental-sync.cjs`
- Modify: `package.json`

**Interfaces:**
- Produces `CloudCursor`, `cursorAfterRows(rows)`, `isRowAfterCursor(row, cursor)`, `mergeIncrementalRows(existing, incoming, pendingIds, options)`, `shouldReconcile(now, state, visibility)`, and `createChangeCoalescer(flush, delayMs)`.
- Row ordering uses `(updated_at, id)` and never loses rows sharing the same timestamp.

- [ ] **Step 1: Write the failing behavior test**

Create a test that imports the compiled/source module and proves: equal-timestamp rows advance by ID, incoming newer rows replace cached rows, pending local rows win, terminal local work orders cannot be revived by older cloud rows, hidden windows do not reconcile, and duplicate events coalesce to one flush.

- [ ] **Step 2: Run the test and verify RED**

Run: `node tools/test-incremental-sync.cjs`

Expected: failure because `src/lib/incrementalSync.ts` or its exports do not exist.

- [ ] **Step 3: Implement the pure utilities**

Keep this module free of Electron, React, Supabase, browser globals, and filesystem access. Accept injected timestamps and callbacks so tests use real behavior without network mocks.

- [ ] **Step 4: Run the focused and type tests**

Run: `node tools/test-incremental-sync.cjs`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: add incremental sync primitives`

### Task 2: Canonical Command Center Workflow Routing

**Files:**
- Modify: `src/lib/repairWorkflow.ts`
- Modify: `src/lib/commandCenter.ts`
- Modify: `src/lib/workOrderLifecycle.ts`
- Modify: `tools/test-command-center-workflow.cjs`
- Modify: `tools/test-command-center-model.cjs`
- Modify: `tools/test-work-order-lifecycle.cjs`

**Interfaces:**
- Produces `deriveOperationalStage(workOrder)` as the only source for checked-in, diagnosing, approval, parts, repair, testing, pickup, and terminal placement.
- Produces `isOperationallyTerminal(workOrder)` and queue eligibility/priority derived from the same normalized state.

- [ ] **Step 1: Extend tests for every approved transition**

Add fixtures for new check-in, diagnosing, approval, waiting parts, parts delivered, repair, testing, complete, not repairable, picked up, closed, reopened, expedited, stagnant, and quick-turnaround tickets. Assert exact panel membership, exclusion, queue ordering, and the eight-record cap.

- [ ] **Step 2: Run tests and verify RED**

Run: `node tools/test-command-center-workflow.cjs`

Run: `node tools/test-command-center-model.cjs`

Run: `node tools/test-work-order-lifecycle.cjs`

Expected: at least the inconsistent transition fixtures fail under the existing distributed rules.

- [ ] **Step 3: Implement canonical derivation**

Normalize legacy aliases and QR workflow values once. Refactor Command Center selectors and lifecycle checks to consume the canonical functions without changing visible labels.

- [ ] **Step 4: Run workflow regression tests**

Run the three focused tests plus `node tools/test-repair-workflow-contract.cjs` and `node tools/test-command-center-live-runtime.cjs`.

Expected: PASS with no production data access.

- [ ] **Step 5: Commit**

Commit message: `fix: centralize command center workflow routing`

### Task 3: Desktop Cache-First Incremental Cloud Reads

**Files:**
- Modify: `app/electron/electron-main.ts`
- Modify: `app/electron/preload.ts`
- Modify: `src/global.d.ts`
- Create: `tools/test-desktop-incremental-sync.cjs`
- Modify: `package.json`

**Interfaces:**
- Adds IPC `cloud:syncCollection(key, options)` returning `{ ok, key, changedRows, deletedIds, cursor, rowsReceived, approximateBytes, syncedAt }`.
- Adds IPC `cloud:getSyncStatus()` returning last success, pending writes, per-collection counters, and last error.
- Existing `dbGet` becomes cache-first for normal renderer reads; explicit synchronization is separate.

- [ ] **Step 1: Write a failing source/runtime contract test**

Assert that normal `db-get` can return the local cache without issuing `select('*')`, incremental cloud reads filter by `updated_at` plus stable ID, changed rows merge without reviving terminal tickets, and sync status exposes actual counters.

- [ ] **Step 2: Run test and verify RED**

Run: `node tools/test-desktop-incremental-sync.cjs`

Expected: failure because the new IPC contracts and cursor reads do not exist.

- [ ] **Step 3: Implement desktop synchronization controller**

Store cursors in a small file under the existing data root. Keep the current first-use bootstrap bounded by requested operational limits, then use incremental reads. Preserve pending-write conflict handling. Return local cache immediately from renderer list reads.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `node tools/test-desktop-incremental-sync.cjs`

Run: `node tools/test-cloud-record-identity.cjs`

Run: `node tools/test-workorder-workflow-sync.cjs`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: make desktop cloud reads incremental`

### Task 4: Command Center Targeted Refresh and Live Row Application

**Files:**
- Modify: `src/components/CommandCenter.tsx`
- Modify: `src/App.tsx`
- Modify: `src/lib/workflowLiveRefresh.ts`
- Modify: `src/components/Toolbar.tsx`
- Create: `tools/test-command-center-egress.cjs`
- Modify: `tools/test-command-center-stale-refresh.cjs`
- Modify: `package.json`

**Interfaces:**
- Command Center initial render consumes cached data.
- One centralized scheduler performs incremental reconciliation at a 15-minute visible interval, on stale focus, and on manual Refresh.
- Record events patch the affected row and model; they do not call the broad loader.

- [ ] **Step 1: Write failing tests for request count and routing**

Prove no 30-second full loader remains, one work-order change does not request unrelated collections, hidden windows skip reconciliation, stale focus triggers one incremental sync, manual Refresh invokes real incremental sync, and terminal rows remain removed.

- [ ] **Step 2: Run tests and verify RED**

Run: `node tools/test-command-center-egress.cjs`

Run: `node tools/test-command-center-stale-refresh.cjs`

Expected: failure because broad `load()` is still called by the 30-second timer and multiple listeners.

- [ ] **Step 3: Replace broad reload triggers**

Load the initial cached collections once, apply payload-bearing local events directly, use the desktop controller for reconciliation, and remove duplicate Command Center Realtime ownership. Client replies keep a narrow shop-filtered subscription and query only unresolved projected columns.

- [ ] **Step 4: Connect truthful sync status**

Make the header status display last successful sync, pending changes, syncing/error state, and the manual refresh result from `cloud:getSyncStatus()`.

- [ ] **Step 5: Run Command Center runtime regression**

Run: `node tools/test-command-center-egress.cjs`

Run: `node tools/test-command-center-stale-refresh.cjs`

Run: `electron tools/test-command-center-live-runtime.cjs`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `feat: refresh command center incrementally`

### Task 5: Mobile Incremental Sync and Notification Deltas

**Files:**
- Modify: `src/mobile/mobile-api.ts`
- Modify: `src/mobile/MobileApp.tsx`
- Modify: `src/lib/notifications.ts`
- Create: `tools/test-mobile-incremental-sync.cjs`
- Modify: `tools/test-mobile-command-center.cjs`
- Modify: `package.json`

**Interfaces:**
- Mobile `dbGet` returns cached lists and exposes explicit collection synchronization using the shared cursor rules.
- Realtime payloads patch one row and emit one collection event.
- Notification synchronization accepts a `changedSince` cursor and processes only returned deltas.

- [ ] **Step 1: Write failing mobile tests**

Assert startup does not download 2,500 complete records, a product event does not reload work orders/sales/customers/technicians, notification checks do not fetch 500 work orders and sales every minute, and background/hidden mode suspends scheduled cloud reads.

- [ ] **Step 2: Run tests and verify RED**

Run: `node tools/test-mobile-incremental-sync.cjs`

Expected: failure under the existing full-read behavior.

- [ ] **Step 3: Implement mobile cache-first deltas**

Persist per-collection cursors in localStorage, merge Realtime payloads, request deltas after reconnect/focus, and limit operational bootstrap data. Keep offline write draining intact.

- [ ] **Step 4: Convert notification polling to deltas**

Retain the existing notification rules but feed them only newly changed work orders, sales, calendar entries, and technicians. Do no cloud read when notification settings make a category irrelevant.

- [ ] **Step 5: Run mobile regression and builds**

Run: `node tools/test-mobile-incremental-sync.cjs`

Run: `node tools/test-mobile-command-center.cjs`

Run: `npm run build:mobile`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `feat: reduce mobile cloud egress`

### Task 6: Supabase Incremental-Read Indexes

**Files:**
- Create via CLI then modify: `supabase/migrations/<generated>_add_incremental_sync_indexes.sql`
- Create: `tools/test-incremental-sync-migration.cjs`
- Modify: `package.json`

**Interfaces:**
- Adds idempotent indexes supporting shop-scoped `(shop_id, updated_at, id)` reads on synchronized high-traffic tables.
- Does not change RLS behavior or expose new data.

- [ ] **Step 1: Write a failing migration contract test**

Assert the migration covers customers, work_orders, sales, calendar_events, calendar_notes, purchase_orders, products, staff_profiles, shop_settings, and client_responses where applicable; require `if not exists`; reject `security definer` and broad public grants.

- [ ] **Step 2: Run test and verify RED**

Run: `node tools/test-incremental-sync-migration.cjs`

Expected: failure because the migration does not exist.

- [ ] **Step 3: Generate and implement migration**

Run `supabase migration new add_incremental_sync_indexes` after checking `supabase migration new --help`. Add only the required indexes. Do not apply production changes while the project is restricted unless authenticated tooling is available and the user separately authorizes the live schema application.

- [ ] **Step 4: Verify migration locally and run advisors when available**

Run the migration contract test, `supabase migration list --local`, and Supabase database advisors if authenticated. Record any inability to reach the restricted project rather than claiming live application.

- [ ] **Step 5: Commit**

Commit message: `perf: index incremental cloud reads`

### Task 7: Full Verification and GitHub Migration Readiness

**Files:**
- Modify: `README.md` only if current repository/updater documentation requires a destination placeholder explanation.
- Create: `docs/github-repository-migration.md`
- Modify: updater/release configuration only after the user supplies the exact new GitHub owner and repository; until then document discovered references without editing them.

**Interfaces:**
- Produces a verified list of every old GitHub owner/repository reference, GitHub Actions secret/variable name, release permission, updater endpoint, Pages URL, and Supabase callback URL that may require migration.

- [ ] **Step 1: Inventory GitHub coupling**

Search source, workflows, package metadata, update configuration, documentation, and runtime environment templates for `Mattstechwisdom`, `GB-POS`, GitHub release URLs, Pages URLs, signing secrets, and release tokens.

- [ ] **Step 2: Write the migration walkthrough**

Document exact new-account steps, repository creation, remote preservation/renaming, branch/tag push, Actions permissions, secret recreation, updater bridge-release handling, APK/release assets, and the checks needed before changing Supabase redirect URLs.

- [ ] **Step 3: Run the focused suite**

Run all tests introduced above plus existing Command Center, cloud identity, workflow, mobile, checkout, QR, and print tests.

- [ ] **Step 4: Run complete static/build verification**

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm run build:mobile`

Expected: all commands succeed without new warnings attributable to these changes.

- [ ] **Step 5: Measure the isolated runtime behavior**

Using an isolated local/test profile, confirm there is no repeating 30-second full-history request, row events update Command Center immediately, manual Refresh performs one incremental reconciliation, and no production test rows are created.

- [ ] **Step 6: Commit**

Commit message: `docs: prepare github repository migration`

- [ ] **Step 7: Stop before remote migration**

Present verification evidence and the walkthrough. Request only the exact new GitHub owner/repository information needed for the external migration. Do not change `origin`, updater URLs, tags, releases, Actions secrets, or Supabase settings yet.
