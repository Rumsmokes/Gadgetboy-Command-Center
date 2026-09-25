# Daily Operations Checklist Design

## Purpose

Give GadgetBoy technicians one concise, accountable daily operating routine that keeps the shop ready, customer communication current, and POS exceptions visible. This is a synced operational record, not a replacement for Calendar tasks.

## User experience

### Command Center entry point

The Command Center receives a prominent **Daily Operations** button. Its summary is always live:

- Opening: not started, in progress, or submitted with technician/time.
- Throughout Day: current progress.
- Closing: due after service closes; submitted with technician/time.
- History opens the last 30 calendar days.

The desktop entry opens as a normal daughter window. On mobile it is a full-height sheet with one expandable checklist section at a time and a fixed, reachable submit action.

### Today

Each date contains three separate checklist submissions:

1. **Opening · 10:00–10:50 AM**
2. **Client follow-up · 10:50–11:00 AM**
3. **Closing · after 7:00 PM**

Before submission, a technician selects their name from active technicians and checks applicable items. A checked item can be cleared until submission. Submit stores a timestamp, technician identity/display name, item snapshot, completed count, total count, and optional concise note. Once submitted it is read-only on every device.

### History

History contains the most recent 30 days only. Entries are compact and factual, such as:

`Sep 25 · Opening · Matt · 12/12 · 10:47 AM`

An unsubmitted set is greyed out. Opening or Closing entries open a read-only detail sheet showing the checklist as it was submitted, including unchecked items and the assigned technician. History has no edit/re-submit path.

Records older than 30 shop-local calendar days are deleted by the shared cleanup flow whenever the system loads or saves a checklist. Cleanup is idempotent and uses the shop-local `dateKey`, not a rolling timestamp.

## Checklist templates

### Opening — 10:00–10:50 AM

- Unlock/open shop; turn on lights and music.
- Power on POS, payment equipment, and needed displays.
- Clean customer counters, intake/register area, glass, technician stations, and floors as needed; empty trash as needed.
- Review Command Center: Needs Attention, client replies, active tickets, and Ready for Pickup.
- Review EOD Cart and expected deliveries; identify paid but unordered items.
- Check inventory/low stock and today’s deliveries.
- Complete today’s manually assigned Calendar tasks.
- Prepare technician stations, tools, chargers, intake area, and supplies.

### Client follow-up — 10:50–11:00 AM

- Review tickets requiring a status update or pickup follow-up.
- Send the appropriate QR-code/client update first.
- Call when an email/update was already sent or a call is needed.
- Record client replies, promises, requested pickup time, and next action on the linked ticket.

### Throughout the day

This section is intentionally available all day and does not conflict with Calendar tasks:

- Re-check Command Center after check-ins, status changes, deliveries, and checkouts.
- Mark physically received parts/products delivered; update inventory only on physical receipt.
- Route repairs through diagnosis, awaiting parts, repair, testing, and pickup with QR/internal updates.
- Keep counters and technician stations clean and safe.
- Resolve or document Needs Attention before it becomes end-of-day work.

### Closing — after 7:00 PM

- Complete remaining client updates and pickup reminders.
- Reconcile Command Center, Needs Attention, delivery tracking, EOD Cart, and outstanding balances.
- Verify active repairs have an accurate stage, technician note, and next action.
- Clean counters, intake/register area, stations, and floors as needed; take trash as needed.
- Count the day’s cash and place it in the safe.
- Secure client devices, parts, and stations.
- Turn off music, lights, and other nonessential equipment; secure doors and alarm.

## Data model and synchronization

Add a synced `dailyOperationsChecklists` collection. Each record contains:

```ts
{
  id: string,
  dateKey: 'YYYY-MM-DD',
  period: 'opening' | 'follow_up' | 'throughout_day' | 'closing',
  technicianId: string,
  technicianName: string,
  submittedAt: ISOString,
  items: Array<{ id: string; label: string; checked: boolean }>,
  completedCount: number,
  totalCount: number,
  note?: string,
  createdAt: ISOString,
  updatedAt: ISOString
}
```

The complete item snapshot is stored on submit so historic records remain truthful if a template is later changed. A uniqueness rule of `(dateKey, period)` prevents duplicate submissions across devices. The first successful submit wins; a competing device reloads the immutable saved record.

No client data, credentials, payments, or emails are duplicated in the checklist collection. Checklist prompts link technicians back to existing POS areas rather than copying their data.

## POS integration

- The Command Center summary uses the same `dateKey` and synced collection, so a new submission is visible immediately after sync/refresh.
- “Needs Attention,” Client Replies, EOD Cart, Product Delivery, and Calendar tasks remain their existing systems. The checklist only tells a technician to review them and can provide direct open actions.
- Active technician names come from the existing Technician administration data and preserve existing display-name cleanup.
- A submitted checklist is audit history only. It cannot update ticket workflow, inventory, or financial data by itself.

## Verification

- Unit tests cover template content, completion totals, immutable submit behavior, duplicate-submit protection, and 30-day pruning.
- Command Center tests verify summary state changes after a synchronized submit.
- Desktop/mobile render tests verify the button, read-only history, mobile section collapse, and fixed submit control.
- Existing data remains unaffected; there is no migration of historical Calendar tasks into checklist submissions.
