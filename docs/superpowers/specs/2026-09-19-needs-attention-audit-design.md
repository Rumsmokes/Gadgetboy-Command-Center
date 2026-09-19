# Needs Attention Audit Desk

## Purpose

Needs Attention is the POS's audit desk. It must make exceptions visible before they become reporting, inventory, client-communication, or record-integrity mistakes. It does not silently change a ticket. Each alert identifies the affected record, explains why it was flagged, shows its operational context, and opens the exact corrective workflow.

This applies to records created on or after September 1, 2026. Older records remain available in All Invoices and reporting, but do not create historical noise in the audit desk unless they are already actively being worked.

## Data and alert model

The existing Command Center model remains the single source for work orders, sales, consultations, customer identity, technicians, purchase orders, calendar entries, and cleanup settings. Its existing lifecycle checks continue to produce issue codes. The audit desk adds presentation metadata without duplicating or changing source records.

Every flagged record is projected into one or more audit entries with:

- priority: urgent, review, or follow-up;
- group: Urgent follow-up, Money & inventory review, or Client communication & ticket details;
- source type and record ID;
- client, device/product, status, assigned technician, balance, and relevant activity time;
- a plain-language reason derived from the existing issue code;
- a targeted action label and action destination.

Unread client replies, overdue pickup/storage review, client approval awaiting action, failed synchronization or email delivery, and work that must be actively decided appear as urgent. Missing part sourcing, ETA/tracking, cost, internal cost, restock reconciliation, and payment/invoice integrity appear under Money & inventory. Missing required ticket details, technician assignment, client contact follow-up, unscheduled consultations, and incomplete newly created records appear under Client communication & ticket details.

Future part ETA and scheduled pickup commitments suppress inappropriate stale-work or no-contact alerts, preserving the existing lifecycle intent.

## Window and interaction

The Needs Attention command-center panel becomes a focused audit window rather than a generic table. It contains:

1. A concise audit purpose and a visible audit-date scope.
2. Filter chips for all issues, date scope, work orders, sales, and money/inventory. Filters never alter source records.
3. Four live metrics: urgent count, money/inventory count, communication/detail count, and current-month record completeness.
4. Grouped alert sections, each with a count and a short explanation.
5. Dense rows displaying the record, client/device or product, reason and supporting detail, operational status/balance, and a direct Fix button.
6. Existing double-click, right-click, hover, and long-press behavior for the underlying record, alongside the direct Fix action.

The direct Fix action opens the existing record, reply panel, pickup workflow, ordering details, technician assignment control, or correct report view as appropriate. It does not automatically apply financial or workflow changes.

Resolved alerts disappear on the next Command Center refresh or live data event. A refresh control rebuilds the model from persisted POS data.

## Completeness and reporting rules

New ticket creation and checkout validation remain the primary protection: required information is collected before a new record can advance. Needs Attention is the exception layer for later failures, imported/legacy-adjacent records, failed asynchronous work, incomplete payment/inventory linkage, and overdue workflow activity.

The completeness metric counts in-scope tickets and sales that have no active audit reason, divided by all in-scope records. It is an operational indicator, not a replacement for accounting reconciliation or a payment processor settlement report.

## Error handling

If data cannot be loaded, the panel shows a clear retry state rather than reporting zero alerts. Unknown issue codes remain visible in a General review subgroup with their supplied reason, so a new rule can never hide an exception. Missing optional client/device metadata is displayed as "Not recorded" and remains eligible for an alert when it is a required field.

## Verification

Tests will verify:

- issue-code-to-group and priority mapping;
- cutoff handling and no false stale alerts for future ETA/scheduled pickup;
- correct live totals and grouping from the Command Center model;
- a record with multiple problems remains visible with each reason;
- resolved records disappear after model refresh;
- Fix actions route to the appropriate existing POS workflow;
- desktop and mobile rendering retain readable rows without horizontal overflow.
