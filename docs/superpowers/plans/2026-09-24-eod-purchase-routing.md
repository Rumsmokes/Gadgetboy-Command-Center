# EOD Purchase Routing and Overdue-Cart Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep paid order-required parts and products in the EOD cart until ordered or explicitly removed, route linked tickets correctly, and audit overdue or incomplete purchasing work.

**Architecture:** `orderAccounting.ts` becomes the single source for EOD eligibility and queue-age metadata. `commandCenter.ts` derives purchase audit reasons from the same line-item lifecycle, while `EODWindow.tsx` persists the selected items' checkout state and optionally emits existing client updates. No new Supabase tables are required: normalized line-item fields continue through the existing ticket synchronization.

**Tech Stack:** React, TypeScript, Electron IPC, existing Supabase ticket sync, Node static regression checks.

**Spec:** `docs/superpowers/specs/2026-09-24-eod-purchase-routing-design.md`

## Global Constraints

- Physical order-required work-order parts and sale products remain eligible without an internal cost; labor, diagnostic, fee, client-provided, salvaged, and in-stock items do not.
- EOD client updates default to Internal only; the technician explicitly opts in to client delivery.
- Needs Attention remains scoped to the existing September 1, 2026 audit floor.
- EOD checkout must persist item state before Command Center refresh and never send an email during refresh-only operations.
- Existing ordered, received, delivered, and in-stock line items remain absent from the outstanding cart.

## Review Focus

- A paid part with no internal cost must be visible in the cart and flagged for its missing cost.
- A line created before this release without `purchaseQueueAddedAt` must age from its existing ticket/line timestamp.
- A removed paid line must remain absent from the cart but appear in Needs Attention until restored or resolved.
- A mixed cart checkout must send updates only for explicitly opted-in rows.
- A purchase checkout must immediately route a work order to Awaiting Parts and a sale to Product Delivery after persistence.

---

### Task 1: Centralize EOD purchase eligibility and queue-age metadata

**Files:**
- Modify: `src/lib/orderAccounting.ts:1-339`
- Test: `tools/test-order-accounting.cjs`

**Interfaces:**
- Produces: `isOutstandingOrderItem(item, record, sourceType)`, `purchaseQueueAgeHours(item, record, now)`, and cart rows with `queueAddedAt` and `missingCost` metadata.
- Consumes: existing `collectOrderCartRows(workOrders, sales, purchaseOrders)` callers.

- [ ] **Step 1: Write failing cart-eligibility tests**

```js
const paidNoCost = { id: 91, payments: [{ appliedParts: 65 }], items: [{ id: 'screen', repair: 'Screen', parts: 65, requiresOrder: true, orderStatus: 'needed' }] };
assert.ok(collectOrderCartRows([paidNoCost], [], []).some(row => row.key === 'workOrder:91:screen'));
assert.equal(collectOrderCartRows([paidNoCost], [], [])[0].hasCost, false);
assert.equal(collectOrderCartRows([{ ...paidNoCost, items: [{ ...paidNoCost.items[0], isLabor: true }] }], [], []).length, 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tools/test-order-accounting.cjs`

Expected: failure because `needsWorkOrderPurchase` rejects an item with no internal cost.

- [ ] **Step 3: Implement minimal eligibility and timestamp support**

```ts
function needsWorkOrderPurchase(item: any, record: any) {
  if (item?.purchaseQueueRemovedAt || isNonPurchasableLine(item)) return false;
  const requiresOrder = item?.requiresOrder === true || Boolean(normalizePartOrderUrl(item?.orderSourceUrl || item?.productUrl || record?.partsOrderUrl || ''));
  return requiresOrder && outstandingOrderStatus(item, record) === 'needed';
}

function queueAddedAt(item: any, record: any) {
  return String(item?.purchaseQueueAddedAt || item?.createdAt || record?.updatedAt || record?.createdAt || '');
}
```

Expose `queueAddedAt` and `missingCost: cost === null` on every returned `OrderCartRow`.

- [ ] **Step 4: Run order-accounting checks to verify they pass**

Run: `node tools/test-order-accounting.cjs`

Expected: PASS, including the no-cost paid-item eligibility case.

- [ ] **Step 5: Commit**

```bash
git add src/lib/orderAccounting.ts tools/test-order-accounting.cjs
git commit -m "fix: retain unpaid purchase tasks in EOD cart"
```

### Task 2: Add overdue purchase audit reasons to Command Center

**Files:**
- Modify: `src/lib/commandCenter.ts:1-290`
- Modify: `src/lib/workOrderLifecycle.ts:104-145` only if shared reason helpers are required
- Test: `tools/test-command-center-workflow.cjs`

**Interfaces:**
- Consumes: outstanding-order helpers and queue timestamps from Task 1.
- Produces: `AttentionReason` codes `purchase-queue-overdue`, `purchase-cost-missing`, `purchase-url-missing`, and `purchase-queue-removed` on linked work orders and sales.

- [ ] **Step 1: Write failing Command Center audit tests**

```js
const overdue = wo(92, 'Parts', {
  createdAt: '2026-09-20T09:00:00.000Z',
  items: [{ description: 'Battery', requiresOrder: true, orderStatus: 'needed', purchaseQueueAddedAt: '2026-09-20T09:00:00.000Z', parts: 40 }],
});
const model = buildCommandCenterModel({ workOrders: [overdue], sales: [], customers: [], technicians: [], now: new Date('2026-09-22T10:00:00.000Z') });
assert.ok(model.needsAttention.some(row => row.id === 92 && row.attentionReasons.some(reason => reason.code === 'purchase-queue-overdue')));
```

Add tests that a post-September-1 item without cost or URL receives the corresponding reason, and an `ordered` item receives none.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tools/test-command-center-workflow.cjs`

Expected: failure because purchase-cart reasons are not yet derived.

- [ ] **Step 3: Implement audit derivation from saved line-item lifecycle**

```ts
const purchaseReasons = purchaseAttentionReasons(record.source, record.kind, now);
record.attentionReasons.push(...purchaseReasons);
```

Use the cart helper status rules so the same item cannot be simultaneously treated as ordered in EOD and overdue in Needs Attention. Preserve the existing audit start-date filter.

- [ ] **Step 4: Run Command Center workflow checks to verify they pass**

Run: `node tools/test-command-center-workflow.cjs`

Expected: PASS for overdue, missing-cost, missing-URL, removed-row, and resolved-order cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/commandCenter.ts src/lib/workOrderLifecycle.ts tools/test-command-center-workflow.cjs
git commit -m "feat: audit overdue EOD purchase tasks"
```

### Task 3: Persist EOD checkout routing and explicit client-delivery choice

**Files:**
- Modify: `src/components/EODWindow.tsx:100-150, 1800-2060, 3300-3540`
- Modify: `src/lib/repairWorkflow.ts:100-130` only if a shared persisted stage patch is needed
- Test: `tools/test-order-accounting.cjs`
- Test: `tools/test-command-center-workflow.cjs`

**Interfaces:**
- Consumes: `OrderCartRow.queueAddedAt`, selected-cart row keys, and existing `sendCartClientUpdate`.
- Produces: persisted item fields `purchaseQueueAddedAt`, `purchaseQueueCheckedOutAt`, `orderStatus`, `orderDate`, and optional update delivery intent.

- [ ] **Step 1: Write failing EOD checkout behavior tests**

```js
assert.match(eodSource, /sendClientUpdateKeys/);
assert.match(eodSource, /purchaseQueueCheckedOutAt/);
assert.match(eodSource, /deliveryMode.*internal/);
assert.match(eodSource, /workflowStage:\s*'Parts'/);
```

Add a routing fixture proving ordered work orders enter Parts and ordered sales surface in Product Delivery after the persisted line patch.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tools/test-order-accounting.cjs && node tools/test-command-center-workflow.cjs`

Expected: failure because EOD checkout has no explicit per-row client-delivery intent or queue completion timestamp.

- [ ] **Step 3: Implement explicit default-internal checkout controls and writes**

```ts
const [clientUpdateKeys, setClientUpdateKeys] = useState<Set<string>>(new Set());
const shouldSendClientUpdate = clientUpdateKeys.has(cartRow.key);

return {
  ...item,
  purchaseQueueAddedAt: item.purchaseQueueAddedAt || now,
  purchaseQueueCheckedOutAt: now,
  requiresOrder: true,
  orderStatus: 'ordered',
  orderDate: date,
  estimatedDelivery: deliveryForRow(cartRow),
};
```

Render a per-item `Send client update` checkbox unchecked by default. Call `sendCartClientUpdate` only when `shouldSendClientUpdate` is true. Save work-order stage `Parts` and sales' existing ordered product state before invoking UI refresh.

- [ ] **Step 4: Run EOD and Command Center regression checks to verify they pass**

Run: `node tools/test-order-accounting.cjs && node tools/test-command-center-workflow.cjs && npm run typecheck`

Expected: PASS. An internal-only checkout makes no client-delivery call, while opted-in rows do.

- [ ] **Step 5: Commit**

```bash
git add src/components/EODWindow.tsx src/lib/repairWorkflow.ts tools/test-order-accounting.cjs tools/test-command-center-workflow.cjs
git commit -m "feat: route EOD purchases with optional client updates"
```

### Task 4: Integrate remediation affordances and full release verification

**Files:**
- Modify: `src/components/CommandCenter.tsx:400-450` if a purchase-audit row needs a dedicated EOD-cart action
- Test: `tools/test-command-center-workflow.cjs`
- Test: `tools/test-mobile-command-center.cjs`

**Interfaces:**
- Consumes: purchase audit reasons from Task 2 and EOD checkout state from Task 3.
- Produces: a direct safe remediation action that opens EOD for purchase-related Needs Attention records.

- [ ] **Step 1: Write a failing remediation test**

```js
assert.match(commandCenterSource, /Open EOD Cart/);
assert.match(commandCenterSource, /purchase-queue-overdue/);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tools/test-command-center-workflow.cjs`

Expected: failure because purchase alerts currently offer only the generic ticket action.

- [ ] **Step 3: Implement the direct remediation action**

```tsx
<button onClick={() => dispatchOpenModal('eod', { focusPurchaseKey: entry.record.id })}>
  Open EOD Cart
</button>
```

Keep the generic record action for non-purchase alerts. Do not create an update message as a side effect of opening the cart.

- [ ] **Step 4: Run complete verification**

Run: `node tools/test-order-accounting.cjs && node tools/test-command-center-workflow.cjs && npm run test:mobile-command-center && npm run test:mobile-layout && npm run typecheck && npm run build && npm run build:mobile`

Expected: all commands exit 0.

- [ ] **Step 5: Commit and publish**

```bash
git add src/components/CommandCenter.tsx tools/test-command-center-workflow.cjs
git commit -m "feat: remediate overdue EOD purchase alerts"
npm version 0.1.15 --no-git-tag-version
npm run dist
npm run android:apk
git add package.json package-lock.json
git commit -m "release: prepare v0.1.15"
git push origin codex/tutorial-emails-pricing-v0.6.57
git tag v0.1.15
git push origin v0.1.15
```

Create the GitHub release only after the installer, `latest.yml`, blockmap, and APK are present and verified.