# Technician QR accountability and collected-payment audit design

**Date:** 2026-09-27

## Purpose

Make each technician action performed through a work-order QR code attributable to an individual technician, make the Command Center's **Collected Today** tile a reliable drill-down into today's actual checkout transactions, and start repair statistics from trustworthy events recorded on or after this design's rollout date.

## Scope

This design covers the following related workflows:

1. **Collected Today drill-down.** The existing Command Center tile stays in place and continues to show the sum of payments recorded today. Selecting it opens a daughter window containing one transaction row per payment event, rather than one row per invoice.
2. **Mandatory technician PIN on each QR scan.** A technician enters the PIN assigned in Technician settings before any staff QR actions are available. The existing Supabase-authenticated staff boundary remains in place; the PIN identifies the individual operator and is verified by the server rather than trusted from the browser.
3. **Attributed QR actions.** Client emails, internal technician notes, status changes, promises, requests, and delivery-related QR actions retain technician ID, display name, event time, and whether a client message was sent.
4. **Repair statistics.** Statistics begin fresh from the rollout date and derive only from timestamped technician workflow events. Diagnostic fees, additional fees, and historical ticket records do not contribute to repair-duration learning.
5. **QR email confirmation cleanup.** After a QR action successfully sends a client email, its confirmation page displays a five-second countdown and attempts to close that browser tab. If a browser prevents closing a user-opened tab, the page becomes a safe completion screen with no POS navigation or record data.

## Collected Today

### Tile behavior

The Command Center continues to show the existing **Collected Today** button, total amount, and payment count. The total is calculated exclusively from distinct payment-ledger events whose actual recorded timestamp falls on the shop's local current day.

### Transaction log

Clicking the tile opens **Today’s Payment Log**, ordered newest first. Each row shows:

- date and local time;
- invoice type and identifier (for example, `WO #1234` or `Sale #1235`);
- client name when one is attached, otherwise a clear `Quick checkout` label;
- concise item/payment description (for example, `Diagnostic fee`, `Part payment`, `Final repair payment`, or sale item summary);
- payment method when available;
- amount collected.

A diagnostic checkout and later remainder/final checkout are two independent rows. Duplicate local representations of the same ledger event are de-duplicated by event key. Historical correction entries remain visible in reporting at their supplied historical date, but never inflate today's checkout total solely because they were entered today.

## Technician QR identity

### Scan flow

1. A staff member scans a work-order QR link.
2. Existing staff authentication is still required.
3. The page presents a minimal PIN keypad before displaying any status, notes, or client-message controls.
4. The technician enters their assigned PIN on **every newly opened QR scan/tab**.
5. The server validates the PIN against the active shop and returns a short-lived, token-scoped technician identity for that QR session.
6. The page then exposes the normal QR controls.

The client-facing status and email-response pages remain public token-scoped pages and never receive POS access or staff controls.

### Attribution

Every QR action records the validated technician's legacy ID/profile ID, technician display name, action timestamp, status transition, optional internal note, and whether a client update was sent. Existing history is rendered in two distinct sections:

- **Client updates**: sent email/status messages, delivery/pickup notices, approval requests, and client-facing timestamps.
- **Technician progress**: internal diagnostic, repair, testing, ordering, delivery, and notes—with the responsible technician.

## Status routing and repair statistics

Status changes retain their existing Command Center routing rules and additionally write trustworthy timestamps:

- `diagnosing` starts diagnosis timing;
- `testing` starts/records testing timing;
- `repair completed` records a repair completion timestamp and routes to ready for pickup;
- `repair not possible` routes to ready for pickup but is excluded from completed-repair duration statistics.

The repair-statistics baseline is the rollout date. Only repair work with a technician-attributed diagnosis start and valid repair-completion event participates. Fees, diagnostics alone, additional fees, historical unverified events, and not-repairable pickups are excluded.

## QR email success screen

When an update sends a client email successfully, the staff QR page shows `Email sent — this tab will close in 5 seconds`, updates the countdown once per second, then invokes `window.close()`. A visible `Close now` button remains available. If closing is browser-blocked, the completion screen stays isolated and contains no links into the POS.

## Verification

Automated coverage will verify:

- same-day ledger events create distinct payment-log rows and sum correctly;
- event deduplication does not double-count mirrored payment data;
- historical payment adjustments do not count as a new collection today;
- incorrect/missing PIN blocks staff QR actions;
- a valid PIN is required on each fresh QR tab and writes technician attribution;
- client versus technician history splits correctly;
- diagnosis/testing/completion actions create the fields consumed by repair statistics;
- fees and not-repairable flows do not contribute to repair-duration averages;
- a successful email confirmation starts the five-second close logic, while public client pages do not.
