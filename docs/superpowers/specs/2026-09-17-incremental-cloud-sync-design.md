# GB POS Incremental Cloud Sync and Command Center Routing Design

Date: 2026-09-17

## Objective

Reduce Supabase egress by replacing repeated full-collection downloads with cache-first incremental synchronization while preserving immediate multi-device updates. At the same time, make Command Center ticket placement deterministic so work orders enter, move between, and leave operational sections immediately when their workflow state changes.

This work does not migrate, delete, or rewrite production records. It does not change the configured Supabase project. GitHub repository migration is a separate publication step performed only after the application changes pass verification and the owner creates or selects the destination repository.

## Confirmed Root Cause

The current desktop Command Center downloads customers, technicians, up to 2,000 work orders, sales, calendar events, calendar notes, purchase orders, settings, and client replies on initial load, every 30 seconds while visible, when the window gains focus, and after several collection-change events. Realtime subscriptions can trigger the same complete reload through more than one path.

The mobile application loads up to 2,500 work orders and 2,500 sales plus customers and technicians, reloads those collections for unrelated collection changes, and can download up to 500 work orders plus 500 sales each minute for notification reconciliation. Cloud collection reads use `select('*')`, including payload and detail fields that summary screens do not need.

## Architecture

### 1. Centralized Cloud Synchronization

Introduce one synchronization controller per runtime:

- Electron main process owns desktop cloud reads, writes, cursors, and the local JSON cache.
- The mobile API owns mobile cloud reads, writes, cursors, and its local storage cache.
- Renderers request cached collections and subscribe to collection-specific change messages; they do not independently start broad cloud refreshes.
- Realtime events invalidate or patch only the affected collection/record.
- Rapid duplicate events are coalesced by collection and record identifier.

The controller tracks a successful-sync cursor for each collection. A cursor consists of the most recent server `updated_at` value and a stable row identifier used as a tie-breaker. Incremental reads request only rows newer than that cursor. Deletes must be represented by a tombstone/change-log mechanism or by targeted Realtime delete events; a periodic reconciliation verifies active operational records without downloading all historical records.

### 2. Cache-First Behavior

Screens render from the local cache immediately. Cloud synchronization happens asynchronously:

1. Return cached rows to the requesting screen.
2. Request changed rows from Supabase.
3. Merge changed rows using server timestamps and existing pending-write protection.
4. emit one collection-specific update containing the changed record(s).
5. Persist the new cursor only after a successful merge.

When Supabase is unavailable, cached data remains usable and local changes remain in the existing durable cloud-write queue. Authentication still follows Supabase security requirements; no bypass or embedded privileged key is introduced.

### 3. Purpose-Built Summary Reads

Operational surfaces receive compact projections instead of full records:

- Command Center: active work orders, today's completed/collected tickets, unresolved client replies, pending ordered products, today's calendar counts/details, and the fields required to calculate priority and balances.
- All Invoices: server-side pages of ten records with server-side filtering and search.
- Mobile home: active/recent summaries rather than 2,500 complete work orders and sales.
- Notifications: records changed since the last notification cursor, not the latest 500 records every minute.

Full ticket payloads, histories, signatures, passwords, and complete line-item metadata load only when their owning work-order, sale, consultation, customer, reporting, or administrative window requires them.

Where a schema-safe projection cannot reconstruct an existing local record, use a dedicated SQL view or RPC with `security_invoker = true`, shop-scoped RLS, explicit authenticated grants, and only the minimum returned columns. No `SECURITY DEFINER` function is used merely to bypass RLS.

### 4. Reconciliation

Realtime is the fast path, not the only correctness mechanism.

- Run a lightweight incremental reconciliation after sign-in, reconnection, manual Refresh, and at a 10–15 minute visible-window interval.
- Pause scheduled synchronization while the window/app is hidden.
- On focus, synchronize only if the last successful reconciliation is stale.
- Manual Refresh performs one incremental reconciliation and displays the result.
- A rare bounded active-record reconciliation corrects missed Realtime events without pulling closed historical tickets.

### 5. Command Center Workflow Routing

Create one canonical workflow-state derivation function used by Command Center cards, counts, panels, queue prioritization, and collection-change handling. UI text does not independently determine routing.

Routing rules:

- New nonterminal work order: Active Work Orders and Checked In; eligible for Today's Repair Queue.
- Diagnosing update: Diagnosing section; eligible for the prioritized repair queue.
- Awaiting approval: Approval section; excluded from work-ready queue until approved.
- Part ordered / waiting for part: Awaiting Parts; excluded from Today's Repair Queue until required parts are delivered.
- Required parts delivered: returned to the repair queue at the delivered-parts priority tier.
- Repair in progress: Repair section and active queue according to priority.
- Testing update: Testing section and prioritized near the top of the repair queue.
- Repair complete: Ready for Pickup; removed from repair queue.
- Repair not possible: Ready for Pickup with no invented charge; removed from repair queue.
- Picked up, explicitly closed, cancelled, voided, deleted, or archived: removed from all active/queue/pickup operational sections and retained in history/reporting.
- Reopened: returned to the appropriate active section based on the latest nonterminal workflow state.

Today's Repair Queue remains capped at eight and is ordered:

1. Expedited service
2. Parts delivered / ready to resume
3. Diagnosing or testing in progress
4. Learned quick-turnaround repairs
5. Stagnant active work orders
6. Other eligible checked-in work orders

The same canonical rules process QR updates, in-app Client Update actions, checkout, Picked Up, manual close, and cloud updates from another device. A terminal ticket cannot be reintroduced by an older cloud row.

### 6. Event Application

On a local or cloud record change:

- Apply the changed row to the local cache.
- Recalculate only derived Command Center state affected by that record.
- Update an open daughter panel from the same model.
- Remove terminal records immediately and keep them removed after subsequent reconciliation.
- Fetch a complete record only when the user opens it.

Customer, technician, calendar, purchase-order, and client-response changes update only their corresponding indexes or panels. They do not force all work orders and sales to reload.

### 7. Egress Diagnostics

Add lightweight local diagnostics without sending additional telemetry:

- Last successful cloud synchronization
- Collections synchronized
- Rows received and uploaded
- Pending queued writes
- Failed synchronization reason
- Approximate response bytes when measurable

The existing sync indicator reports genuine controller state rather than a static success label. Logs must not include passwords, tokens, client secrets, or sensitive device credentials.

## Data and Schema Changes

Prefer existing `updated_at` columns and existing RLS. Before implementation, inventory every synchronized table and verify that each one has:

- a reliable server-maintained `updated_at`
- a stable primary key and shop identifier
- an index supporting `(shop_id, updated_at, id)` or the corresponding legacy identifier
- an RLS policy that restricts authenticated staff to their shop

If a table lacks these requirements, add a reviewed migration containing only the required timestamp trigger/index/policy correction. If delete reconciliation requires a change log, make it shop-scoped, minimal, and retention-limited. Run Supabase advisors before finalizing schema changes.

## Compatibility and Rollout

- Existing local caches remain readable.
- Missing cursors trigger one bounded bootstrap synchronization, then incremental operation.
- Existing pending writes are drained before or alongside incremental reads without overwriting newer local terminal workflow states.
- Desktop and mobile must understand the same workflow state names.
- A version may temporarily support both legacy full reads and incremental reads behind a fallback, but normal production operation must use incremental reads.

## Testing

Automated tests must cover:

- Initial cache-first rendering without a network response.
- Incremental queries requesting only rows newer than the saved cursor.
- Stable pagination when multiple rows share an `updated_at` timestamp.
- Realtime update, insert, and delete handling without a full collection reload.
- Duplicate event coalescing.
- Hidden-window polling suspension and stale-focus reconciliation.
- Offline writes surviving restart and synchronizing after reconnection.
- Desktop and mobile parity.
- All workflow transitions listed above, from QR actions and in-app actions.
- Closed/picked-up records remaining absent after later synchronization.
- Queue cap and priority ordering.
- All Invoices pages containing ten rows without downloading the complete history.
- Notification checks retrieving only changed records.
- No production test records being inserted.

Runtime verification should instrument request count, rows returned, and response size in an isolated local/test profile. The acceptance target is no recurring full-history read during normal Command Center use and a substantial reduction in bytes transferred compared with the current 30-second polling baseline.

## GitHub Repository Migration Boundary

Application functionality depends on GitHub only for source hosting and release/update distribution; Supabase data and authentication remain separate. After application verification:

1. The owner creates a repository in the new GitHub account.
2. The local repository receives a new remote or the existing `origin` is renamed for preservation.
3. Branches and tags are pushed to the new destination.
4. GitHub Actions secrets and repository variables are recreated manually in the new repository; secrets cannot be exported from the locked account.
5. Release workflow permissions are enabled and a test release is built.
6. The POS updater feed and any hard-coded repository URLs are changed to the new owner/repository.
7. Existing installed clients receive a bridge release from an accessible channel or are manually installed once; afterward they follow the new repository's update feed.
8. Supabase redirect URLs are changed only if any authentication callback currently uses GitHub Pages or a repository-owned domain. The Supabase project itself does not need to move merely because the GitHub account changes.

No remote URL, updater endpoint, release destination, signing identity, Supabase setting, or production deployment is changed without displaying the exact old and new values to the owner first.

## Completion Criteria

- Normal Command Center operation no longer reloads complete collections every 30 seconds.
- Desktop and mobile synchronize changed records promptly and retain offline capability.
- Manual Refresh performs a real incremental reconciliation.
- Every workflow update routes the ticket to exactly one correct operational stage.
- Terminal tickets stay out of active sections after local and cloud refreshes.
- The repair queue remains capped and correctly prioritized.
- Automated and isolated runtime tests pass.
- No production records are created for testing.
- The current GitHub remote remains untouched until the owner supplies and approves the new destination.
