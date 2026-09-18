# Changelog

## v0.1.2 (2026-09-18)

- Adds a responsive Move To submenu to Command Center work-order right-click and touch long-press menus.
- Routes diagnosis, approval, ordered/delivered parts, testing, repair completion, and not-repairable changes through the same status, history, email, and live Command Center workflow used by QR updates.
- Shows compact, action-specific detail forms only when dates, estimates, delivered items, or client-facing notes are needed; labor and fee rows cannot be marked as delivered parts.
- Keeps the ticket in place and shows an error if the workflow update cannot be saved and sent.

## v0.6.99 (2026-09-15)

- Fixes diagnostic and part prepayments incorrectly closing new work orders when their current balance reaches zero. Paid drop-offs remain active and eligible for the priority repair queue; only pickup-ready payment or explicit staff close completes the ticket.
- Persists the initial Checked in workflow on desktop/mobile ticket creation so routing and not-started attention checks have a consistent starting stage.
- Records an explicit Completed workflow on checkout closure. Recent diagnostic-only tickets closed by the older check-in bug appear in Needs Attention with a confirmed, payment-preserving Restore Diagnostic Drop-Off to Active action; genuinely picked-up/completed and legacy-cleaned tickets are excluded.
- Fixes Tasks opening a blank work order from a zero-valued invoice link. Tasks/Events/Notes open their own calendar detail views, including linked tasks and overlapping event/note IDs; consultation invoices retain their existing opening behavior.
- Adds actual Command Center UI regression coverage for new check-ins, live daughter lists, the eight-row priority queue, testing, waiting/delivered parts, not-repairable pickup, closure, safe restoration, and calendar item clicks.

## v0.6.98 (2026-09-15)

- Customer receipts now print a Google Review QR with SCAN ME underneath, using the shop's review link. They never request an internal technician-update URL and do not depend on cloud ticket synchronization to generate their QR.
- Includes the work-order QR lookup and blank part ETA date fixes from the unpublished v0.6.96/v0.6.97 builds.
- Verifies actual customer receipt and work-order print windows render their distinct QR images before printing, including malformed legacy receipt dates.

## v0.6.97 (2026-09-15)

- Includes the work-order QR print fix from the withdrawn v0.6.96 build: reuses existing tokens and avoids re-uploading already-synchronized tickets merely to print.
- Fixes blank part ETA values being sent as empty strings to a PostgreSQL date column, which blocked receipt/work-order QR creation and synchronization. Desktop and mobile now send a valid date or null.
- Verifies both QR lookup paths and waits for the generated print QR image to render before printing.

## v0.6.96 (2026-09-15)

- Fixes work-order QR printing being blocked by an unnecessary full-ticket Supabase upload. Existing QR tokens and already-synchronized tickets no longer require that write before printing.
- Preserves QR image generation/decoding before printing and only synchronizes a ticket when it is genuinely missing from the cloud.

## v0.6.95 (2026-09-15)

- Fixes Command Center routing after QR/client updates by using the newest cloud timestamp and timestamped workflow stage for diagnosis, testing, parts, and pickup.
- Enables staff-only live work-order notifications and reconciles on reconnect/focus, while preventing stale desktop/mobile saves from overwriting newer QR workflow progress.
- Keeps existing payment balances unchanged when routing not-repairable devices to Ready for Pickup.
- Fits desktop calendar date controls to smaller laptop screens, grouping busy-date entries when cell height is limited; retains the mobile calendar layout.
- Expands Category Performance (Sales & Stock), defaulting to Beverages, with on-hand/incoming/out-of-stock totals and filters for sold items, low stock, or out of stock alongside revenue, units, cost, profit, and margin.

## v0.6.94 (2026-09-14)

- Makes Command Center Tasks, Events, Notes, and Consultations open their actual calendar entry, note editor, work order, or sale.
- Prevents a delayed active Supabase row from resurrecting a locally closed or picked-up work order after background synchronization completes.
- Keeps resolved client replies suppressed until Supabase confirms they no longer belong in the unresolved list.
- Makes the legacy sales-ticket print path retry QR creation and stop with a visible error instead of silently printing without a QR code.

## v0.6.93 (2026-09-13)

- Fixes work-order release forms printing before their QR image has finished generating and decoding.
- Retries temporary QR failures and stops printing with a visible error instead of producing a work-order sheet without its QR code.
- Adds a production Electron runtime test that deliberately delays QR creation and verifies the rendered QR is present before printing begins.

## v0.6.92 (2026-09-12)

- Prevents work-order and sales receipts from printing until the required QR code has been created and rendered, with retries for temporary cloud delays and a visible error instead of a QR-less printout.
- Prevents stale refreshes from restoring work orders or client replies after they are closed or resolved in Command Center.
- Verifies close and resolve writes and restores the row with an error message if persistence fails.
- Routes QR/client updates to their authoritative Command Center stages even while an older synchronized workflow field is still present: Diagnosing, Approval, Parts, Repair, Testing, Pickup, and Completed.
- Removes externally closed or picked-up tickets immediately and keeps them out while local/cloud synchronization catches up.

## v0.6.91 (2026-09-12)

- Expands Today’s Repair Queue to eight visible tickets.
- Recalculates and refills the priority queue whenever a work order is closed, picked up, moved to Waiting Parts or Testing, marked not repairable, or otherwise leaves active repair work.

## v0.6.90 (2026-09-12)

- Corrects Collected Today so diagnostic payments, repair checkouts, and sales use every supported payment timestamp and the amount actually applied rather than cash tendered.
- Corrects Ready for Pickup outstanding balances by deriving the live amount due from the ticket total and its payment ledger instead of a stale saved remaining value.

## v0.6.87 (2026-09-12)

- Adds a compact Command Center Today strip for Tasks, Events, Notes, and Consultations, with accurate counts and at-a-glance daughter windows.
- Makes Command Center Refresh visibly reload customers, tickets, sales, calendar data, purchase orders, settings, and client replies.
- Resets Repair Statistics to the new QR-driven workflow era and excludes diagnostics, extra fees, and non-repairable outcomes from learned repair patterns.
- Keeps work orders with undelivered required parts out of Today’s Repair Queue; newly delivered-part jobs rank directly after expedited service.
- Limits Product Delivery to genuinely ordered sales products and adds per-item delivered actions with optional client email.
- Prevents Complete Checkout from hanging indefinitely by falling back to the compatible checkout handoff when desktop acknowledgement stalls.

## v0.6.86 (2026-09-11)

- Limits the live Command Center repair queue to seven tickets and ranks Expedited, Diagnosing/Testing, learned quick-turnaround, stagnant, and ordinary work in that order.
- Learns repair patterns from completed work and adds Repair Statistics for average/median turnaround, quick-turnaround rate, common repairs, and learned quick patterns.
- Refines Needs Attention into a reasoned exception inbox for stalled work, unanswered updates, overdue promises/parts/pickups, synchronization failures, and malformed work orders, sales, or consultations, with configurable timelines.
- Adds Product Delivery for ordered sales items, including quick ticket details and individual or all-item delivery completion that immediately synchronizes and removes delivered lines.
- Replaces the silent one-way Complete Checkout event with an acknowledged, window-scoped checkout session and visible processing/error feedback.

## v0.6.85 (2026-09-11)

- Removes completed and non-repairable devices from Active Work Orders as soon as they enter Ready for Pickup.
- Keeps these tickets visible in Ready for Pickup until a technician selects Picked Up / Close Ticket.
- Closing preserves the full client, invoice, workflow, update, and payment history while removing the ticket from operational queues.

## v0.6.84 (2026-09-11)

- Treats Repair Not Possible, Not Repairable, Repair Declined, and Repair Complete outcomes as Ready for Pickup even when an older workflow stage still says Checked In or Diagnosing.
- Removes all Ready for Pickup and Completed tickets from Today’s Repair Queue while retaining them in the dedicated Ready for Pickup view.
- Publishes only the single signed universal Android APK through the release workflow.

## v0.6.70 (2026-09-10)

- Restored the one-click Windows Auto Update and Relaunch flow so downloaded updates install silently and reopen GadgetBoy POS without stepping through the installer.
- Retained pre-update database flushing, cloud synchronization, background-service shutdown, locked-process cleanup, optional Windows elevation, and the manual download recovery path.

## v0.6.69 (2026-09-09)

- Immediately removes a closed or deleted record from the currently open Command Center daughter list as well as the live dashboard counts and queues.
- Keeps desktop right-click and mobile/tablet long-press record actions synchronized with the visible list without requiring the window to be closed and reopened.

## v0.6.68 (2026-09-09)

- Closed confirmed legacy work orders older than 30 days in the live shop without adding payments or deleting client, invoice, or repair history.
- Made legacy cleanup write complete records, verify each save, and immediately remove newly closed tickets from Command Center counts and queues.
- Preserved the 20-day diagnostic-only and 30-day universal cleanup settings for future automatic reconciliation.
- Restored reliable calendar loading with retries and prevented a transient Supabase failure plus an empty local cache from appearing as an empty calendar.
- Added familiar right-click actions to Command Center invoice and repair rows, including the expanded View All lists.
- Removed the redundant Command Center Filters control and side-menu EOD shortcut, enlarged Quote and Consultation actions, and refined the Command Center title and date styling.

## v0.6.67 (2026-09-09)

- Replaced the legacy mobile landing page with the responsive Shop Command Center used on desktop.
- Kept All Invoices available as a dedicated mobile-friendly record view with Work Order and Sales filters.
- Prevented background data synchronization from repeatedly flashing the “Loading shop data” message.
- Reflowed Command Center stages and record panels for phones without sideways scrolling.

## v0.6.66 (2026-09-09)

- Added synchronized POS settings for automatically closing diagnostic-only legacy tickets after 20 days and all remaining open legacy tickets after 30 days, with editable timelines, a preview, and a manual run button.
- Preserved payments, balances, client history, notes, and checkout information during cleanup; only the ticket status and cleanup audit marker are changed.
- Restored readable mobile calendar cells using the established wide calendar layout instead of compressing seven columns into the phone width.
- Improved technician identity resolution across local, legacy, and cloud IDs so unresolved assignments display as Unassigned or Unknown technician rather than raw identifiers.
- Changed Windows updates to the assisted NSIS flow with elevation support, allowing Windows to replace protected or locked old files and providing a direct download-page recovery action.

## v0.6.65 (2026-09-09)

- Matched the production desktop Command Center navigation and layout to the approved responsive preview.
- Added production window size profiles so calendars, catalog tools, quote generation, reporting, and compact utilities use the space their content needs without smushed controls.
- Reflowed All Invoices, Work Orders, and Sales into labeled cards on phones, eliminating sideways table scrolling while preserving every field and record action.
- Made embedded calendar layouts fill the available desktop space and fit seven readable date columns on mobile without horizontal overflow.
- Standardized mobile daughter-window controls with readable wrapping and touch-friendly sizing.
- Removed the redundant persistent notification rail while keeping the notification bell connected to the full Notifications window.
- Corrected active and Checked In repair counts by excluding closed, checked-out, cancelled, voided, refunded, deleted, and archived work orders regardless of stale balances.
- Resolved assigned technician legacy, local, and cloud identifiers to technician display names; unresolved identifiers now appear as Unknown technician in Needs Attention.
- Kept inventory variants nested directly beneath their parent item instead of duplicating them as standalone rows.

## v0.6.63 (2026-09-09)

- Replaced the desktop landing list with a live Command Center derived from current customers, work orders, sales, consultations, calendar entries, payments, and purchasing records.
- Added actionable Active Work Orders, Awaiting Parts, Ready for Pickup, Collected Today, repair-stage, repair-queue, calendar, and attention drill-downs without introducing sample customer data.
- Kept repairs waiting on future part delivery out of the active daily repair route until their ETA is due, while surfacing delivered or overdue work.
- Added live grouped main search results without replacing the Command Center and retained the existing All Invoices, Work Orders, and Sales & Consultations tables and record-opening behavior.
- Added responsive desktop, tablet, and phone-width layouts with collapsible operational sections and full-width daughter panels on compact screens.
- Preserved existing Quote Generator, Inventory, Repairs, Reporting, Technician, consultation, client, checkout, Admin, work-order, and sale components and their production handlers.
- Updated the desktop toolbar with matching notification, calendar, and fullscreen controls plus EOD and Client Dropoff access.

## v0.6.62 (2026-09-08)

- Added working Supabase-backed QR codes to normal printed sales tickets and delayed automatic printing until QR generation completes.
- Synchronized the underlying ticket before issuing a QR token so freshly created codes resolve correctly across devices.
- Expanded Custom Build part entries with quantity, internal cost, supplier, SKU, order URL, order status, order date, estimated delivery, and tracking URL fields while keeping labor entries concise and non-taxable.
- Preserved all Custom Build ordering metadata through editing, duplication, local persistence, and Supabase synchronization.
- Hardened Windows update installation by flushing pending data, releasing background services, and closing daughter windows before the NSIS handoff.
- Pinned the internal Windows installer builder away from the known NSIS uninstall regression; the GadgetBoy POS application version remains on the 0.6.x release line.

## v0.6.61 (2026-09-08)

- Fixed client searches missing locally queued or recently synchronized customer records.
- Prevented repeated checkout actions and cross-window checkout responses from creating duplicate work orders.
- Made normal saves and deletes return immediately after durable local persistence while Supabase synchronization continues from the retry queue.
- Prevented context-menu deletion overlays from leaving form fields inaccessible.
- Corrected print margins and page-break rules so terms and signature sections do not spill onto an unnecessary page.

## v0.6.59 (2026-09-04)

- Added a separate branded repair-completion thank-you email when the final labor payment clears the work-order balance at pickup.
- Kept diagnostic/drop-off, ordered-part, and completed-repair acknowledgments as distinct idempotent events.
- Final pickup acknowledgments take precedence when the last payment includes both parts and labor.

## v0.6.58 (2026-09-04)

- Fixed repair checkout acknowledgments so only an unpaid diagnostic fee triggers the device drop-off email.
- Diagnostic catalog line items now qualify for the drop-off acknowledgment, including console diagnostics such as PS5 check-ins.
- Later labor payments no longer appear as diagnostic fees, and ordered-part acknowledgments require an actual parts payment.
- Mixed payments show only the amount applied to the diagnostic fee in the acknowledgment.

## v0.6.57 (2026-09-04)
- Repair Tutorials: repair catalog entries can save synchronized YouTube, direct-video, or webpage tutorial links and open them from a dedicated desktop or responsive mobile player with playback controls and browser fallback.
- Branded Automatic Emails: diagnostic intake, ordered-part payment, completed in-stock sale, consultation scheduling, and meaningful consultation changes now create styled client messages with safe-sender and reply guidance.
- Duplicate-Safe Delivery: initial acknowledgments and consultation versions use a shop-scoped database outbox identity, visible history/preview states, and the existing retry-safe sender without rolling back completed payments or bookings.
- Supplier Cost Review: Inventory now offers Check All Prices, Check Selected, and per-item Check Price actions with categorized results, editable proposed costs, confidence warnings, source links, and explicit Approve/Skip controls.
- Audited Cost Changes: approval updates only internal acquisition cost and records the previous, detected, and approved values with supplier-learning feedback for later review or reversal.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.56 (2026-09-03)
- Customer Identity Consistency: customer phone numbers, email addresses, and names now use shared normalization and match-classification rules instead of drifting between workflows.
- Safer Duplicate Handling: exact contact matches are distinguished from name-only suggestions and conflicting contact records, preventing unsafe automatic merges.
- Canonical Client Selection: duplicate resolution now favors the customer already linked to the most transactions, then the most complete and oldest record.
- Transaction Name Recovery: shared label resolution preserves saved client names, resolves linked customer names, and uses a client-number fallback only when no name is available.
- Regression Coverage: automated checks protect US phone normalization, extensions, conflict detection, canonical selection, and transaction customer labels.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.55 (2026-09-02)
- September 11 Calendar Artwork: the supplied memorial image now appears as a slightly translucent background only inside the September 11 month-calendar cell.
- Readable and Responsive: the image is clipped to the date square, ignores pointer input, and stays beneath date controls and calendar entries on desktop and mobile.
- Deployment-Safe Asset: the artwork uses the shared public-asset resolver so it loads correctly in desktop packages and the browser interface.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.54 (2026-09-02)
- Distinct Ticket Catalogs: work orders now use a streamlined Repairs-style picker, while sales use a separate Inventory-style picker with the familiar search and filters.
- Cleaner Ticket Editing: catalog organization stays in Admin; ticket line editors focus on fulfillment, quantity, checkout pricing, availability, and notes while clearly identifying linked catalog records.
- Stable Repair Links: desktop and browser sync now preserve repair legacy IDs, preventing parent-part linking from creating a second repair or unlinking the correct repair when an older duplicate is removed.
- Variant-Safe Work Orders: repairs linked to a parent part family continue to request the exact inventory variant without creating a new repair catalog entry.
- Regression Coverage: automated checks protect repair identity, deletion, parent-part selection, and the distinct work-order and sale picker layouts.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.53 (2026-09-02)
- Immediate QR Update Email Delivery: the authenticated `client-updates` function now forwards the signed-in staff token to the protected mail function, eliminating the gateway 401 that left every normal email queued until manual retry.
- Queue Cleanup: all remaining pending or sending client-update emails were checked and cleared; delivered history remains intact.
- Regression Coverage: automated checks now prevent the automatic mail handoff from reverting to an incompatible service-role credential.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.52 (2026-09-01)
- Reliable Queue Retry Session: Client Update History now resolves the signed-in shop through the actual active staff-profile status field instead of querying a nonexistent field.
- No False Sign-In Prompt: authenticated desktop and web users can retry queued client emails without being incorrectly told that the shop session is not ready.
- Regression Coverage: the client-update checks now protect the correct active-profile lookup on both history loading and queue retry.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.51 (2026-09-01)
- Restored Client Email Delivery: the replacement Gmail App Password is stored as a protected Supabase Edge Function secret and verified against Gmail SMTP without sending a test message.
- Recoverable Update Queue: Client Update History now includes a prominent Retry queued emails action that processes pending emails for the signed-in shop.
- Duplicate-Safe Retries: the cloud sender atomically claims each pending history entry before delivery, preventing simultaneous retries from sending the same update twice.

## v0.6.50 (2026-09-01)
- Correct Diagnostic Totals: a selected diagnostic remains the minimum/credit toward standard repair labor without replacing separate service fees.
- Additive Expedited Fees: expedited service, rush, fee, and surcharge line items now add on top of the diagnostic or completed repair labor in work-order totals, checkout, and saved ticket values.
- Accounting Regression Coverage: automated cases protect diagnostic-only, repair-with-diagnostic, expedited-with-diagnostic, and repair-plus-expedited totals.

## v0.6.49 (2026-09-01)
- Cloud-Authoritative Repair Deletion: desktop Repairs now sends deletion directly to Supabase before cleaning its local cache, so cloud-loaded catalog entries can be removed even when they were never copied into the desktop JSON database.
- Specific Power-Supply Fix: the saved “Playstation 5 Power Supply Swap” record and other cloud-only repairs no longer freeze or return “could not be removed from storage” solely because the local cache lacks their ID.
- Safe History Preservation: deleting a repair still removes only the catalog choice; existing work-order and sale line-item snapshots remain unchanged.

## v0.6.48 (2026-09-01)
- Multi-Device Repairs: repair catalog entries can now target one or several exact devices with the same searchable compatibility picker used by Inventory, while an empty selection keeps the repair category-wide.
- Clear Catalog Roles: Part Type remains the physical inventory category, Linked Repair Service is clearly identified as optional work-order matching, and the internal reusable-service key is generated automatically instead of requiring manual entry.
- Verified Repair Deletion: desktop and browser deletes now require Supabase to return the removed repair row, so a permission or identifier mismatch is shown as an error instead of falsely reporting success.
- Historical Ticket Safety: deleting or editing a catalog repair leaves the independent line-item snapshots, costs, charges, and reporting on existing work orders and sales unchanged.
- Correct Monthly Classification: Quick Repair transactions, including repair-category items such as SSD installs, are treated as repair revenue and no longer appear in product-sales commission, product profit, or product line-item sections.

## v0.6.47 (2026-08-31)
- Vendor List Separation: Distributors/Vendors now shows only retail products in Products mode, while Parts mode shows inventory parts and their linked repairs with mode-correct counts and safeguards.
- Reliable Repair Actions: saved and recovered repair types can be deleted through clear confirmation flows, individual repair deletions refresh persisted lists, and repair menus stay visible above app windows.
- App-Wide Context Menus: the shared right-click menu now enforces a modal-safe layer across inventory, products, repairs, devices, customers, tickets, calendar entries, EOD, and work-order/sale line items.
- Mobile Action Parity: existing press-and-hold behavior remains protected for touch devices without interfering with taps, scrolling, or form controls.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.46 (2026-08-31)
- Reliable Repair Deletion: right-click deletion in Repairs and Repair Settings now verifies persistent storage before refreshing, while Repair Type deletion clearly supports keeping or removing assigned repairs, including recovered types.
- Organized Admin Navigation: the catalog is consistently named Repairs, and Distributors/Vendors has moved out of Admin into Inventory Settings on desktop, mobile, and browser layouts.
- Expanded Catalog Settings: Inventory now includes Part Types, Distributors/Vendors, and configurable entry defaults; Repairs includes Repair Types, Devices, and repair defaults.
- Canonical Vendor Directory: compact expandable vendor rows show linked parts and repairs, prevent deleting in-use vendors, propagate renamed vendor spellings, and support merging accidental duplicates.
- Distributor URL Consistency: product links continue to fill available part cost and now resolve detected distributor names against the canonical vendor directory.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.45 (2026-08-31)
- Independent Admin Windows: desktop Admin tools now open in separate non-modal windows, including multiple instances for multitasking; mobile and browser builds retain responsive in-app navigation.
- Guided Inventory: Inventory now uses clear identity/source, compatibility, pricing, and stock/reorder steps with prominent links to existing or new repairs.
- Shared Catalog Settings: the Admin menu now calls the catalog “Repairs,” while Inventory and Repairs share one settings surface for part types, repair types, and device categories with live cross-window refresh.
- Inventory/Repair Communication: linked repairs derive compatible devices from the authoritative inventory part or parent family, and work-order repair selection ranks matches for the registered device first before exact variant deduction.
- Distributor URL Autofill: supported part URLs now fill available name, distributor, SKU, cost, and marked-up price while preserving intentional existing values.
- Checkout Refresh: the checkout popup has prominent payment-scope cards, payment tiles, option cards, a responsive tender panel, and a clear Complete Checkout action without removing existing features.
- Quick Checkout Completion: successful Quick Checkout now closes its parent modal/window even when Electron correctly refuses a request to close the main POS window.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.44 (2026-08-29)
- Streamlined Repair Editor: Devices/Repairs now separates linked inventory from pricing and removes duplicate stock-count, low-stock, and stock-tracking controls that belong in Inventory.
- Inventory Price Autofill: selecting an exact part or variant fills its inventory cost, customer charge, vendor, and ordering details; selecting a parent family keeps a manually entered default part charge.
- Variant-Specific Pricing: family-linked repairs use the selected variant's selling price, cost, and markup on the work order when configured, while preserving the repair's labor charge and deducting the exact chosen variant.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.43 (2026-08-29)
- Repair Part Families: Devices/Repairs can now link a repair price directly to an inventory parent family instead of requiring one specific color, model, or component variant.
- Exact Variant at Use: adding a family-linked repair to a work order automatically chooses the sole device-compatible variant or presents a prominent variant picker when multiple options remain, ensuring the exact installed part is deducted.
- Pricing Safety: choosing a parent family preserves the repair's configured customer-facing parts and labor price; variant selection supplies the exact inventory identity and stock record without replacing the catalog repair price.
- Standalone Part URL Autofill: pasting a distributor product URL now fills an empty distributor field from the domain immediately, even when the remote page blocks metadata scraping, without overwriting a manually entered vendor.
- Stable Technician Editing: opening Edit Technician no longer triggers an unchanged autosave that closes the window after two seconds; later background saves persist without dismissing the form, while the Save button still closes after success.
- Monthly Commission Reconciliation: eligible product sales now form one month-level commission pool that is rounded once and divided across selected technicians with no more than one unavoidable cent of difference.
- Clear Profit Language: the product-only margin card is now labeled Product Sales Gross Profit beneath Product Sales & Vendors, preventing it from being mistaken for total shop profit.
- Supplier Tax Costing: non-exempt supplier tax and checkout costs are included in acquisition cost exactly once, including the compatibility fallback for older purchase records; customer sales tax remains excluded from profit.
- Styled Spreadsheet: the end-of-month download is now an Excel-compatible formatted workbook with prominent totals, readable headings, alternating line items, and separated technician, product, consultation, and supplier-purchase sections.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.42 (2026-08-29)
- Standalone Part URL Autofill: pasting a distributor product URL now fills an empty distributor field from the domain immediately, even when the remote page blocks metadata scraping, without overwriting a manually entered vendor.
- Stable Technician Editing: opening Edit Technician no longer triggers an unchanged autosave that closes the window after two seconds; later background saves persist without dismissing the form, while the Save button still closes after success.
- Monthly Commission Reconciliation: eligible product sales now form one month-level commission pool that is rounded once and divided across selected technicians with no more than one unavoidable cent of difference.
- Clear Profit Language: the product-only margin card is now labeled Product Sales Gross Profit beneath Product Sales & Vendors, preventing it from being mistaken for total shop profit.
- Supplier Tax Costing: non-exempt supplier tax and checkout costs are included in acquisition cost exactly once, including the compatibility fallback for older purchase records; customer sales tax remains excluded from profit.
- Styled Spreadsheet: the end-of-month download is now an Excel-compatible formatted workbook with prominent totals, readable headings, alternating line items, and separated technician, product, consultation, and supplier-purchase sections.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.41 (2026-08-29)
- Stable Technician Editing: opening Edit Technician no longer triggers an unchanged autosave that closes the window after two seconds; later background saves persist without dismissing the form, while the Save button still closes after success.
- Monthly Commission Reconciliation: eligible product sales now form one month-level commission pool that is rounded once and divided across selected technicians with no more than one unavoidable cent of difference.
- Clear Profit Language: the product-only margin card is now labeled Product Sales Gross Profit beneath Product Sales & Vendors, preventing it from being mistaken for total shop profit.
- Supplier Tax Costing: non-exempt supplier tax and checkout costs are included in acquisition cost exactly once, including the compatibility fallback for older purchase records; customer sales tax remains excluded from profit.
- Styled Spreadsheet: the end-of-month download is now an Excel-compatible formatted workbook with prominent totals, readable headings, alternating line items, and separated technician, product, consultation, and supplier-purchase sections.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.40 (2026-08-29)
- Monthly Commission Reconciliation: eligible product sales now form one month-level commission pool that is rounded once and divided across selected technicians with no more than one unavoidable cent of difference.
- Clear Profit Language: the product-only margin card is now labeled Product Sales Gross Profit beneath Product Sales & Vendors, preventing it from being mistaken for total shop profit.
- Supplier Tax Costing: non-exempt supplier tax and checkout costs are included in acquisition cost exactly once, including the compatibility fallback for older purchase records; customer sales tax remains excluded from profit.
- Styled Spreadsheet: the end-of-month download is now an Excel-compatible formatted workbook with prominent totals, readable headings, alternating line items, and separated technician, product, consultation, and supplier-purchase sections.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.39 (2026-08-29)
- Quick Checkout Completion: successful quick sales and repairs now close the Quick Checkout window automatically after persistence, inventory processing, and optional receipt printing finish.
- Faster Inventory Navigation: parent parts and variants expose edit, add/duplicate, expand/collapse, label, and protected delete actions through desktop right-click and mobile press-and-hold; exact device searches prioritize the matching device group.
- Technician Identity: technicians can choose from 25 synchronized profile icons across Default, Neon Retro, Matrix Glitch, and Gothic Dark themes, with live avatars beside ticket assignments and main-list technician names.
- Daily Look Tasks: technician avatars now carry prominent open-task badges, filter individual assignments when selected, and keep All Technicians tasks in a separate compact stack.
- Compatibility: technician icons use one nullable additive profile field and remain excluded from all customer printouts.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.38 (2026-08-29)
- Device-First Inventory: repair parts can be browsed by exact compatible device, part category, parent part, and variant without duplicating stock records.
- Shared Compatibility: one physical part appears beneath every assigned compatible device while keeping a single authoritative count.
- Durant Part Links: Durant Media can save a supplier part URL and a separate invoice URL on each proposed line item.
- Styled Durant Review: GadgetBoy opens a responsive review panel with pricing cards, clickable links, findings, notes, history, and approval controls instead of raw proposal data.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.37 (2026-08-29)
- Collapsed Part Families: parent inventory rows start collapsed and expand on demand, keeping large variant catalogs compact on desktop and mobile.
- Device-Aware Part Selection: parent-linked repairs automatically choose a child part only when the work-order device has one exact compatible match.
- Approval Before Guessing: multiple compatible parts or missing compatibility data open the exact-part picker instead of silently deducting an uncertain SKU.
- Stable Variant Editing: variant attribute fields retain focus while names and values are typed instead of recreating the input after each character.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.36 (2026-08-28)
- Parent Parts: organize related physical SKUs beneath a non-stock parent while every child variant keeps its own attributes, SKU, cost, price, vendor, stock, low-stock level, and MOQ.
- Exact Consumption: parent-linked repairs require the technician to choose the installed child variant; organizational parents cannot be sold or deducted and checkout remains idempotent.
- Repair Families: reusable service keys and device-scoped assignments keep broad services organized while retaining device-specific pricing, labor, and linked part families.
- Client History Actions: work orders, sales, and consultations expose Open/Edit and confirmed Delete through right-click or mobile press-and-hold, replacing bottom Delete controls.
- Diagnostic Visibility: diagnostic-only work orders show the selected diagnostic in the main Items column without adding it to the work-order line-item editor.
- Supabase Sync: additive hierarchy fields are deployed to the GB POS project and synchronized through desktop and mobile serializers.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.35 (2026-08-28)
- Printout Recovery: restores consultation, work-order, sale, and other application printouts that could render as blank pages after inventory labels were introduced.
- Isolated Label Printing: inventory-only visibility and thermal page sizing now activate only while Print Label is running and are removed after printing or cancellation.
- Inventory Checkout Audit: verifies Quick Checkout, regular sales, and closed work orders all deduct linked tracked inventory through the same durable, idempotent consumption path.
- Duplicate Protection: per-sale/per-work-order line markers continue preventing repeated deductions during immediate checkout and later startup reconciliation.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.34 (2026-08-28)
- Inventory QR Labels: every saved part or product can open a thermal-label preview containing its name, SKU/item number, and a scannable QR code.
- Printer-Friendly Sizing: label previews support 2 × 1, 2.25 × 1.25, and 3 × 2 inch stock, then use the operating-system print dialog for thermal-printer selection.
- Scan-to-Restock: authenticated QR scans open the exact inventory record with on-hand count, low-stock threshold, MOQ, and reorder controls.
- EOD Purchasing: scanned items use the established supplier cart, default to MOQ, accept a manual quantity and supplier total, and prevent duplicate pending entries.
- Responsive Layout: inventory rows and label previews were verified at phone, landscape, and desktop widths.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.33 (2026-08-27)
- Distributor Order Dates: selected-item checkout can record the actual historical order day while whole-cart checkout remains on today; delivery estimates stay independent and client updates name the entered order date.
- Item Discounts: work-order and sale line-item menus support custom percentage or fixed discounts, with net totals and printouts calculated consistently.
- Diagnostic Minimums: every work-order type can select a configured Diagnostic outside the line-item list; it behaves as a minimum labor charge so prior diagnostic payments correctly reduce pickup balance.
- Durant Reports: adds Full Transfer status, stable print headers, saved device passwords, Durant-specific receipt wording, hosted deep-link QR codes, shared notes, and chronological history.
- Durant Media Workspace: adds a responsive, RLS-restricted Supabase role that can stage findings, labor, invoice links, markup-ready items, and transfers for GadgetBoy approval without changing authoritative reporting before approval.
- Web & iOS: adds an installable responsive PWA with GadgetBoy home-screen icons and safe-area support.

Web Interface: https://mattstechwisdom.github.io/GB-POS

## v0.6.32 (2026-08-25)
- Android Task Saves: completing, reopening, or editing a task now persists immediately instead of showing a failure and reverting.
- Calendar Save Recovery: ordinary calendar entries now send a valid null shift-request status, fixing Supabase rejection of task, note, event, and autosave updates.
- Cross-Platform Consistency: Windows and Android use the same validated calendar status mapping so saved changes refresh consistently on every device.
- Pending Mobile Writes: previously queued Android calendar updates can retry through the corrected serializer after the app updates.
- Regression Coverage: executes both platform serializers and verifies empty or invalid request statuses become null while valid shift-request states remain intact.

## v0.6.31 (2026-08-25)
- Immediate Task Feedback: Calendar and Daily Look update task checkboxes as soon as they are changed, including individual occurrences of recurring tasks.
- Reliable Task Editing: saved task edits replace the visible calendar record immediately and restore the prior value with a clear warning if persistence fails.
- Immediate Calendar Notes: newly saved or edited notes appear at once while Supabase stores the canonical shared record.
- Durable Repair Journal: Save Note now writes existing work-order notes and journal history immediately instead of waiting for the general work-order autosave.
- Cross-Device Refresh Ordering: desktop collection refresh events now fire after Supabase accepts or queues a change, preventing stale cloud rows from replacing fresh task and note updates.
- Quote Prompt Copy: restores Copy AI Prompt on Windows and Android with a clipboard fallback for restricted Electron and mobile contexts.
- Regression Coverage: verifies task recurrence completion, immediate note persistence, desktop/mobile synchronization mappings, and portrait/landscape behavior.

## v0.6.30 (2026-08-24)
- Stable Task Composer: typing a task subject or body no longer triggers autosave and changes the Add Entry window into an existing-task editor.
- Preserved Task Workflow: the entry-type rail, Add to Task List action, staged-task list, and Save Tasks action remain visible until the technician explicitly saves.
- Existing Edit Autosave: edits to tasks already stored in Calendar continue to autosave normally, as do other calendar entry types.
- Regression Coverage: verifies new task drafts stay unsaved while existing tasks and other calendar entries retain autosave eligibility.

## v0.6.29 (2026-08-24)
- Direct Task Save: pressing Save Tasks now persists the valid task currently entered in the editor even when Add to Task List was not clicked first.
- Multi-Task Preservation: staged tasks and the current typed task are committed together without duplicating blank or previously staged entries.
- Clear Save Count: the Save Tasks button displays the complete number of tasks that will be written to Calendar and Supabase.
- Validation and Sync: timed drafts retain start/end validation and saved tasks continue through the shared calendar collection on Windows and Android.

## v0.6.28 (2026-08-24)
- Repair-Aware Inventory: resolves every checked-out repair to its inventory part using Repair Type plus the work order's saved device category, device name, and model.
- Shared-Part Compatibility: one generic repair name such as HDMI or Screen Replacement can consume the correct PS5, Xbox, phone, or other part from its compatible-device list without device names in the repair title.
- Missed Checkout Recovery: desktop and Android reconcile completed work-order parts at startup when a prior checkout saved without its inventory deduction.
- Duplicate Protection: durable per-ticket line markers prevent the same repair from reducing stock again on another device or later app launch.
- Historical Safety: reconciliation ignores work orders completed before the matched inventory part was created, avoiding deductions from repairs that predate tracked stock.
- Supabase Sync: repaired quantities and consumption markers persist through the shared products collection so every signed-in installation receives the corrected stock.

## v0.6.27 (2026-08-23)
- Recurring Calendar Entries: adds synced daily, weekly, and monthly recurrence to the Calendar Add Entry workflow on Windows and Android.
- Flexible Monthly Rules: supports exact calendar dates plus first, second, third, fourth, or last weekday patterns such as the last Saturday of each month.
- Recurring Tasks: shows recurring tasks in Calendar and Daily Look while keeping completion tracked per occurrence instead of completing the entire series.
- Reliable Important Notes: immediately refreshes newly saved notes from the shared database and shows a visible error if persistence fails.
- Exact Note Formatting: preserves pasted spaces, indentation, and line breaks in Calendar notes and task details across saved and reader views.
- EOD Deliveries: adds an independently scrollable Deliveries section beneath Low Stock for purchased work-order and sale items awaiting arrival.
- Arrival Workflow: marking an item delivered updates its exact invoice line, closes its expected-delivery calendar entry, updates the purchasing ledger, and sends the matching client arrival email.
- Supabase Parity: deploys recurrence storage and round-trip mappings for desktop and mobile clients so every signed-in install renders the same calendar series.
- Devices / Repairs Workspace: aligns the permanent repair catalog with Inventory by keeping the catalog list on the left and a fixed editor pane on the right.
- Explicit Repair Actions: separates Update Repair from Add New Repair so edits cannot accidentally create duplicates and new entries cannot overwrite a selected repair.
- Exact Device Scope: adds a model selector beneath Device Category while retaining category-wide repairs, allowing inventory parts to match the correct saved device model.
- Expandable Catalog Management: device categories and repair types reveal their assigned devices or repairs, with edit/delete actions moved to right-click and mobile touch-and-hold menus.
- Unified QR Routing: replaces newly printed work-order LAN/IP links with the same Supabase token-backed route used by sales and consultations, and brands the opened page as GB Update Interface.
- Release Safety: verifies recurrence math, Supabase mappings, note/task regressions, cart client updates, TypeScript, production builds, and responsive Calendar editor layout.

## v0.6.26 (2026-08-23)
- Inventory Repair Types: adds a saved Repair Type field directly beneath Device Category for repair parts on Windows and Android.
- Exact Part Matching: resolves catalog repairs to inventory using Repair Type plus the work-order device category and compatible device models, with explicit repair links remaining authoritative.
- Work-Order Stock: links the resolved part to the line item and deducts its quantity after a verified parts payment or completed checkout without double-consuming it across devices.
- Installer Naming: publishes the Windows setup as `GB-POS-installerx64-<version>.exe` while retaining the separate universal Android APK.
- Fixed Product Picker: confines scrolling to the left product catalog while keeping the right-side details, Save, Add, and Cancel controls stationary.
- Fixed Quick Checkout: locks the window to the usable viewport and compacts its totals footer so Checkout remains visible without scrolling the page.
- Responsive Checkout: preserves the fixed editor and footer behavior on desktop plus Android portrait and landscape layouts.
- Time-Off Requests: adds a prominent synced Calendar request workflow for a full day OFF or custom start/end hours without changing recurring Technician schedules.
- Schedule Review: displays a high-visibility pending badge and lets schedule managers approve or decline requests; approval becomes the existing dated shift override and red Shift indicator.
- Calendar Header: moves the thicker Streaming/Content Schedule action beside the date controls while keeping Request Time Off alongside Schedule Management.
- Supabase Parity: stores request status, full-day selection, submission time, and review time across Windows and Android, with local backup support.
- Release Safety: verifies the desktop picker at 1280x720 and the full Android portrait/landscape window suite plus calendar request, shift, and cloud-mapping regressions.

## v0.6.25 (2026-08-22)
- Calendar Entry Rail: moves Parts/Products, Events, Consultation, Streaming/Content, and Tasks into a compact left-side selector while preserving the existing contextual fields on the right.
- Per-Day Shift Changes: edits technician start/end times or marks a technician OFF for one selected date without changing the recurring schedule saved in Technicians.
- Shared Shift Overrides: stores date-specific changes in synced calendar records, applies them in Calendar and Daily Look on every device, and includes them in local backups.
- Shift Change Visibility: turns the calendar Shift icon red and labels changed rows whenever a date-specific override exists; restoring regular hours removes the override.
- Multi-Technician Tasks: assigns one task to multiple selected technicians while retaining the All Technicians option and carried-forward Daily Look behavior.
- Release Safety: expands calendar regression coverage and verifies desktop and Android production bundles plus the portrait mobile entry layout.

## v0.6.22 (2026-08-20)
- Selective Cart Checkout: allows any chosen parts or products within a distributor cart to be purchased without requiring the entire distributor group.
- Exact Shared Costs: allocates entered shipping and checkout fees only across the selected line items while retaining the full entered amount to the cent.
- Immediate Cart Reconciliation: removes each successfully purchased line from the cart while leaving unselected or failed lines available for a later checkout.
- Reporting Ledger Sync: saves one durable `checked_out` Supabase purchase record per selected line so EOD, monthly reporting, supplier cost, and purchasing budget totals update from the same source of truth.
- Retry Safety: keeps failed selections and their quantities intact, clears consumed distributor costs only after every selected line for that distributor succeeds, and reports item-level failures.
- Release Safety: adds regression coverage for partial distributor selection, exact additional-cost allocation, cart removal, and reporting-cost retention.

## v0.6.21 (2026-08-20)
- Batch Calendar Tasks: stage multiple tasks for one technician or All Technicians, review existing and pending work for the selected day, then save the complete batch to the synced calendar at once.
- Focused Task Entry: resets the subject and details after each staged task while retaining the selected date, technician, and schedule for efficient repeated entry.
- Mobile Quick Checkout: gives product and repair editing a dedicated full-width mobile workspace with accessible fields, stable totals, and always-visible Save, Cancel, and Checkout controls in portrait and landscape.
- Desktop Window Fit: sizes Quick Checkout and its catalog daughter window against the active display so the fixed editor and checkout footer remain inside the usable screen area.
- Feedback Screenshots: imports up to four compressed screenshots through the native Windows or Android photo picker, previews or removes them before saving, and syncs them with the feedback record through Supabase.
- Release Safety: expands regression coverage for task batching, screenshot persistence, mobile product and repair editing, active-display sizing, and fixed checkout controls.

## v0.6.20 (2026-08-19)
- Durable Part Editing: saves work-order line-item URL, supplier cost, marked-up client charge, repair title, quantity, distributor, markup, and order status immediately when the line-item Save button is pressed.
- Supabase Field Parity: preserves the complete line-item JSON when a work order is reopened on Windows or Android instead of discarding purchasing fields during form reconstruction.
- Cross-Device Commit: waits for a successful Supabase write or a durable offline-sync queue entry before a desktop work-order or sale write reports success.
- Cloud Record Updates: caches records opened through Supabase search before editing so desktop updates cannot fail because the ticket was absent from the local cache.
- Exact Cart Math: calculates supplier cost and the client parts charge on the same quantity basis while retaining labor as the repair charge, keeping Cart cost, charged total, and margin aligned with Checkout.
- Required Assignment: prevents work orders and sales from being saved, force-saved, autosaved, or checked out until a technician is assigned.
- Work Order Header: moves Status and Dates to the top-left sidebar control and gives Assigned To the wider top-row position on desktop and mobile.
- Release Safety: adds production-data auditing and regression coverage for Supabase payload retention, immediate commits, cross-device updates, technician validation, and multi-quantity cart totals.

## v0.6.19 (2026-08-18)
- Exact Daily Collection: attributes every real Checkout to the time payment was taken, even when the work order or sale was created on an earlier day.
- Historical Corrections: keeps manually restored paid amounts on their historical ticket date so they remain in month, year, and lifetime reporting without fabricating current-day revenue.
- EOD Reconciliation: scans every ticket's payment history instead of filtering whole tickets by one representative date, fixing the audited daily total from `$81.48` to `$131.48`.
- Payment-Based Breakdown: derives EOD labor charged, parts/products charged, tax, and matching internal cost from the paid portion of each invoice rather than recounting the full ticket.
- Tender Accuracy: uses each payment's applied amount as collected revenue while retaining cash tender and change details.
- Release Safety: adds regression coverage for an old ticket checked out today, historical paid corrections, and the complete audited `$131.48` checkout set.

## v0.6.18 (2026-08-17)
- Payment-Ledger Reporting: records each work-order and sale checkout on the date payment was actually taken, including multiple partial payments against a remaining balance.
- Exact Financial Allocation: separates collected labor, parts/products, and client tax while recognizing the matching internal cost and calculating gross profit without treating tax as profit.
- Monthly Accuracy: bases monthly repair totals, product sales, consultation commission, internal cost, and profit on payments collected during that month instead of ticket creation dates or unpaid invoice totals.
- Live Reporting Refresh: reloads Reporting immediately after work-order or sale checkout events, including Supabase-synced changes from another device.
- Local Date Boundaries: fixes Eastern-time date filters so evening checkouts remain in the selected business day.
- Legacy and Reclaimed Data: retains older paid tickets through dated fallback payment entries and treats explicit zero-cost reclaimed parts as known cost rather than missing accounting data.
- Release Safety: adds deterministic regression coverage for split payments, remaining balances, tax, proportional product cost, profit, legacy payments, and live report refresh wiring.

## v0.6.17 (2026-08-17)
- Calendar Purchasing Budget: moves date-specific budget creation and editing from EOD into Calendar while preserving the synced daily budget data already used by Cart.
- Desktop Calendar: places Budget immediately left of Add on every calendar date so the spending limit is set in the context of the intended day.
- Mobile Calendar: adds a purple budget control beside each weekly day Add icon and keeps Budget beside Add in Daily view across portrait and landscape.
- Cart Budget Display: keeps daily budget, checked-out spend, selected cost, remaining funds, and over-budget warnings visible in Cart without allowing edits there.
- Release Safety: adds source assertions and live Electron interaction checks for the Calendar budget editor in Android portrait and landscape layouts.

## v0.6.16 (2026-08-17)
- Customer Receipts: removes QR codes from work-order and sales customer receipts while preserving QR-based updates on the dedicated operational forms.
- Receipt Printing: removes the obsolete QR-generation wait so automatic and silent customer receipt printing can proceed as soon as the receipt logo is ready.
- Release Safety: prevents customer receipt QR rendering from returning while retaining Supabase QR coverage for sales forms and consultation sheets.

## v0.6.15 (2026-08-17)
- Inventory Save Reliability: restores every part-specific field after Windows reads a saved listing back from Supabase, including item type, compatible devices, part type, distributor details, markup, reorder data, and stock history.
- Explicit Inventory Actions: replaces the duplicate Add and Clear controls with separate Update Product / Part and Add New Product / Part actions so edited fields can update the selected listing or create a distinct listing.
- Compatible Device Search: replaces the fixed multi-select box with a searchable multi-device picker and removable selected-device tags on desktop and mobile.
- Reclaimed Parts: allows Used parts to be saved without distributor or supplier cost and keeps all zero-cost or costless items out of the EOD purchasing cart and supplier checkout totals.
- Quick Checkout Layout: locks the outer Android Quick Checkout window while keeping its item area scrollable so totals and Checkout remain visible in portrait and landscape.
- Release Safety: adds Supabase field-parity, inventory persistence, costless purchasing, and live mobile layout regression checks.

## v0.6.14 (2026-08-16)
- Mobile Checkout Accuracy: passes the live work-order balance into the Android checkout window and waits for a real saved or cancelled payment result instead of immediately treating the modal as successful.
- Parts and Labor Payments: calculates remaining parts and labor from recorded payment allocations, preserves legacy diagnostic payments as labor-first, and restores Parts, Labor, and Both choices on mobile.
- Mobile Work Order Flow: places client information and Update Client at the top, moves Status & Dates above technician assignment, and keeps its menu inside the visible daughter-window area.
- Expandable Work Order Sections: makes Parts Tracking and Internal Notes compact expandable sections on mobile while preserving the established desktop layout.
- Quick Checkout Mobile Layout: gives Quick Checkout, repair selection, product selection, temporary line editing, totals, and payment controls dedicated portrait and landscape sizing with independently scrollable lists.
- Release Safety: adds source assertions and live Electron checks that complete a mobile payment and verify the exact parts/labor allocation returned to the work order.

## v0.6.13 (2026-08-16)
- Mobile Checkout Restoration: restores the shared Payment panel, tax controls, totals, remaining balance, and Checkout action in work-order and sale windows without duplicating financial calculations.
- Record-Specific Updates: adds Update Client directly beneath work-order client information and preserves the existing sale and consultation routing on Windows and Android.
- Client Window Cleanup: removes duplicate outer close controls from Search Client and Add Client, keeps Save and X together for new clients, and lets shaded daughter-window backdrops return to the previous screen.
- Customer Identity Reliability: persists the resolved customer name and phone with new work orders and refreshes invoices and customer records together so the main screen immediately shows current names instead of stale Customer-number placeholders.
- Quick Checkout Catalog: supports selecting multiple products in one catalog visit, keeps catalog data unchanged, and adds all selected temporary lines to the checkout together.
- Quick Checkout Layout: keeps product/repair lists independently scrollable, holds temporary edit fields in the right pane on desktop, and prevents totals or Save actions from being covered in mobile portrait and landscape layouts.
- Feedback Keyboard Action: makes the Delete key invoke the same confirmed delete workflow as the visible Delete button while protecting active text fields.
- Release Safety: adds focused source assertions plus Electron portrait/landscape checks for every changed daughter window.

## v0.6.12 (2026-08-15)
- Sales QR Restoration: prints a Supabase-backed sale update QR on both the Sales Form and Customer Receipt instead of using the retired shop-LAN route.
- Consultation QR Restoration: prints the consultation calendar-reminder QR on Consultation Sheets and waits for the QR image before silent printing begins.
- Record-Specific Client Updates: places Update Client directly beneath client information in sales and consultation windows, with sales routed to sale updates and consultations routed to their linked calendar event.
- Consultation ID Safety: fixes newly booked consultations so Update Client uses the consultation event ID rather than the related sale ID.
- Release Safety: expands the Supabase QR regression checks to cover both print formats and both record-specific update workflows.

## v0.6.11 (2026-08-15)
- Client Update History: gives Update Client and scanned QR workflows a prominent History button backed by the existing Supabase invoice archive.
- Delivery Audit: shows the exact invoice, client, update type, timestamp, recipient, customer message, estimated date, and delivery result with sent, queued, and failed totals.
- Responsive History Window: replaces the easy-to-miss inline list with a focused daughter window tailored for Windows, Android portrait, and Android landscape.
- Shop Isolation: scopes history by active shop, invoice type, and invoice ID so similarly numbered records cannot mix across shops.
- Release Safety: adds Supabase routing assertions and focused Electron portrait/landscape checks for history visibility, controls, summary counts, and horizontal fit.

## v0.6.10 (2026-08-15)
- Consultation Partners: adds a third location choice beside In-Store and At-Home / On-Site with a synced directory of grouped businesses, saved addresses, optional unit numbers, and custom hourly pricing.
- Partner Management: supports Add Partner, remembered group suggestions, grouped partner selection, and desktop right-click or Android press-and-hold actions for editing and deleting saved partners.
- Partner Pricing: automatically calculates the consultation total from the selected partner's hourly rate and saved duration while preserving deliberate custom charges and hour-based technician commission.
- Mobile Directions: adds Open Maps for partner and other off-site consultation addresses from mobile consultation and calendar details.
- Mobile Quote Clients: keeps Add Client fields directly beneath Search Client and Add Client instead of placing the embedded form at the bottom of Quote Generator.

## v0.6.9 (2026-08-15)
- Purchasing Budget: adds a purple daily Budget action beside Add Part / Product, tracks completed cart checkout spend, and previews the remaining amount as line items or distributor carts are selected.
- Reporting Safety: keeps the daily budget strictly visual and separate from EOD/monthly costs, revenue, profit, taxes, and commission; over-budget checkout remains an explicit warning rather than fabricated financial data.
- Cross-Device Cart State: synchronizes purchase ledger and shop-setting changes on Windows and Android through the authenticated Supabase tables so daily budget usage stays current across devices.
- Daily Look: makes task content open its notes without toggling completion and routes consultations, events, orders, and deliveries to their linked invoice, calendar entry, or purchasing cart.
- Mobile Calendar: gives the day/date lane more room in portrait and landscape and stacks the numeric date beneath the abbreviated weekday.
- Gidget: streams local desktop answers as they generate, tightens model context and response limits, and preserves a partial answer if the model reaches its response deadline.

## v0.6.8 (2026-08-14)
- Checkout Window: removes the overlapping in-app close button from the desktop checkout route and relies on the native Windows title bar while preserving Android's mobile close control.
- Release Safety: adds a regression check that keeps checkout excluded from the global desktop daughter-window close overlay.

## v0.6.7 (2026-08-14)
- Client Actions: adds an equal-size Consultation button beside New Work Order and New Sale on saved and newly added client profiles, with distinct green, blue, and purple styling on Windows and Android.
- Consultation Handoff: opens the booking window with the selected client already saved and selected across desktop and mobile workflows.
- Consultation Records: removes product-order dates, delivery dates, part URLs, and tracking fields from consultation sales and clears inherited ordering metadata when a consultation is saved.
- Quick Checkout: gives the desktop workspace enough room for line-item editing and isolates the tax/totals footer so it cannot overlap the product actions after an item is added.
- Product Selection: keeps the desktop catalog list as the only scrolling pane while sale-only product fields remain stationary on the right; mobile retains its compact vertical flow.
- Reporting Navigation: consolidates Summary, End of Day, and End of Month reports into one selector and makes the all-records Summary the default overview.
- Reporting Settings: combines commission rules with persistent date-range, record inclusion, tax, payment, and visible-section preferences without changing saved financial records.
- Month-End Layout: groups headline totals into Repair Revenue, Commission, Profit and Vendors, and Verified Purchasing sections instead of one long metric row.

## v0.6.6 (2026-08-14)
- End of Day Activity: restores a prominent Tickets Not Closed section whenever Activity Drill Down is expanded, covering every open or unchecked-out work order and sale.
- Ticket Review: opens the complete actionable ticket list from the section while preserving double-click invoice opening, desktop right-click, mobile hold, and close-ticket accounting safeguards.
- Open Ticket Warnings: keeps higher-risk diagnostic, paid, and repair-complete warnings separate from the complete unclosed-ticket count.

## v0.6.5 (2026-08-14)
- Client Contact Decisions: saves declined phone and email choices with each client through the authenticated Supabase record on Windows and Android.
- Client Overview: shows declined contact methods crossed out with a focused Add contact action so technicians can add information later without recreating the client.
- Quick Checkout: keeps product and repair lists independently scrollable while temporary line-item fields remain fixed beside the list on desktop.
- Quick Checkout Editing: restores editable repair fields, preserves checkout-only overrides without changing the permanent catalog, and supports desktop right-click and mobile press-and-hold.
- Quick Checkout Window: removes the redundant header Close button while retaining the native window close control and checkout cancellation action.

## v0.6.4 (2026-08-14)
- Gidget Responses: bounds shop-session, POS-context, memory, and history work so a stalled database request can no longer leave the chat permanently checking.
- Local AI Performance: keeps prompts inside the model context window, requests direct answers without hidden reasoning, and uses a CPU-appropriate response length on Windows and Android.
- Gidget Feedback: distinguishes shop-context preparation from local answer generation and always clears the active response state on success, failure, or timeout.

## v0.5.99 (2026-08-13)
- Android Startup: removes an unsafe forced reporting bundle that caused the published 0.5.98 APK to fail before React mounted, and adds a visible startup recovery screen instead of an unexplained black page.
- Release Safety: opens the built production mobile bundle during release validation and blocks publication when startup logs an error or leaves an empty app root.
- Mobile Work Orders: removes repeated device labels from repair line items, keeps the actual catalog repair title ahead of supporting descriptions, and centers Add Product below the catalog and custom-item actions.
- Parts Tracking: gives mobile order and estimated-delivery date controls stable responsive widths without changing the desktop work-order arrangement.
- Feedback: retains completed submissions for three days, supports explicit deletion, and keeps active/completed feedback easier to distinguish.
- Gidget: improves local-model discovery, download-path handling, retry and repair controls, and read-only POS record analysis while preserving authenticated, shop-scoped memories.

## v0.5.98 (2026-08-13)
- Calendar Day Controls: replaces the stretched daily Notes control on desktop with equal Notes and Tasks buttons; Tasks opens the selected date's checklist and shows open/total progress.
- Task Scheduling: adds an All Day choice or synchronized Start Time and End Time fields, displays the saved range in task details, and rejects incomplete or backwards time ranges.

## v0.5.97 (2026-08-13)
- Automatic Order Updates: checking out linked work-order and sale cart items now sends the client one authenticated Part Ordered or Product Ordered email per invoice, archives it in client update history, and preserves existing technician notes.
- Checkout Delivery Feedback: cart results distinguish sent, queued, skipped, and failed client notifications without undoing successfully recorded supplier purchases.
- Calendar Color Settings: replaces ambiguous Default labels with clearer current-color details, prominent color controls, and separate Reset actions on desktop and mobile.

## v0.5.96 (2026-08-13)
- Mobile Calendar Settings: opens the complete settings workspace above the mobile shell with reliable scrolling, visible save/cancel controls, business-date options, color wheels, and icon settings in portrait and landscape.
- Mobile Window Reliability: adds an automated read-only audit covering all 38 registered daughter windows at phone portrait and landscape sizes without loading or changing Supabase shop records.
- Responsive Tools and Forms: removes clipped desktop widths from Developer Tools, release forms, consultation sheets, and mobile print tables while retaining their desktop and print layouts.
- Receipt Rendering: fixes invalid SVG gradient properties that generated runtime warnings when customer receipts opened.

## v0.5.95 (2026-08-13)
- Calendar Sync: keeps important notes, new tasks, edits, completions, and deletions synchronized through the existing authenticated Supabase calendar tables on Windows and Android.
- Sync Reliability: adds collision-resistant calendar IDs for simultaneous multi-device entry and foreground refreshes for Calendar, Daily Look, and Journal so open desktop windows do not remain stale.
- Mobile Calendar: tightens the seven-day portrait layout, preserves landscape behavior, keeps event icons independently scrollable, and protects the app toolbar from the Android status-bar inset while scrolling.
- Mobile Navigation: aligns Shop Access in the drawer and makes the Android Back button close the current in-app daughter window before leaving the POS.
- End of Day: contains Activity Drill Down and its detail lists within mobile widths, moves open-ticket review into the expanded drill-down, and keeps the desktop overview concise.
- Desktop Main Screen: places Filters first beside the All Activity, Work Orders, and Sales & Consultations controls.

## v0.5.94 (2026-08-12)
- End of Day: restores the visible open-ticket reconciliation warning, keeps it live as work orders and sales sync, and adds desktop right-click/mobile hold actions to open or close an invoice without treating its unpaid balance as collected revenue.
- Windows Updates: restores a one-click Auto Update and Relaunch action while retaining a download-only fallback, and clarifies the Android system-installer action.
- Mobile Navigation: restores the hamburger drawer by applying its visible and interactive open state when rendered.
- Hidden Game Menu: adds CPU-driven Tic-Tac-Toe, Connect Four, and Blackjack alongside Ship, Captain & Crew, with responsive Windows and Android layouts.

## v0.5.93 (2026-08-12)
- Calendar Workflow: places task assignment before task entry, adds invoice/order/tracking/delete context actions for right-click and mobile press-and-hold, and preserves tracking URLs across desktop Supabase sync.
- Calendar Styling: adds synced per-category icon customization using letters, symbols, emoji, or small uploaded images.
- Durant Report: adds an AV/sound work-order type with the full work-order workflow and an authenticated email handoff to Durant Media.
- Technicians: uses the compact technician-card layout on desktop while preserving schedules, passcodes, time records, and analytics.
- Hidden Game Menu: entering the exact uppercase `GADGETBOY` search keyword reveals a self-contained Ship, Captain & Crew dice game on Windows and Android.
- Windows Updates: retains the verified per-user, non-elevated installer settings required for automatic update installation without a UAC approval prompt.

## v0.5.92 (2026-08-11)
- Desktop Navigation: restores the approved slide-out desktop menu, top client actions, filter dropdown, right notification rail, Gidget logo entry point, Feedback button, and animated drawer closing without reverting newer features.
- Calendar Tasks: adds an explicit All Technicians assignment, carries shared incomplete tasks into every technician's Daily Look, and synchronizes completion state through Supabase on Windows and Android.
- Technician Sync: restores authoritative Supabase staff-profile loading and Realtime refresh on desktop while keeping private technician passcodes out of Realtime.
- Client Updates: aligns consultation QR records with Supabase calendar fields and redeploys the authenticated client-update and Gmail app-password email functions.
- Release Safety: expands release regressions for desktop navigation, Tasks, Daily Look shifts, technician sync, repair filtering, record types, client updates, mobile long-press, and silent non-elevated Windows updates.

## v0.5.91 (2026-08-11)
- Desktop Navigation: restores the slide-out side menu as an overlay drawer with the existing toolbar menu control and click-away backdrop, while retaining all current filters, client actions, Feedback, and Quick Checkout.

## v0.5.90 (2026-08-11)
- QR Codes: desktop and mobile now create and resolve opaque status tokens directly in Supabase, and every generated public QR link opens the GitHub Pages client-update or consultation page.
- Hosting: removes the remaining Railway runtime fallbacks from QR routing, mobile public-app URLs, and Gidget context loading. Gidget continues with its local model when no optional context endpoint is configured.
- Mobile: opens the authenticated Update Client panel when a Supabase QR token is present in a hosted link.
- Release Safety: adds source-level checks to prevent Railway QR or Gidget fallbacks from returning.

## v0.5.79 (2026-08-11)
- Hosting: removes the Railway server, runtime configuration, and deployment files; the public mobile and QR experience now deploys to GitHub Pages without a recurring hosting bill.
- Shared Data: keeps Windows and Android records synchronized directly through Supabase, preserving the existing shop database and offline queue behavior.
- Client Updates: routes authenticated work-order, sale, and consultation updates through Supabase Edge Functions, with status history and Gmail app-password delivery handled server-side.
- QR Codes: creates opaque Supabase tokens and opens the free GitHub Pages client-update or consultation-reminder page, so printed QR codes continue to work when the shop PC is off.
- Consultation Reminders: adds a public, minimal-data reminder page that downloads a one-hour-prior calendar reminder without exposing Supabase service credentials.
- Distributor URLs: identifies only the distributor from pasted URLs; product scraping and Railway-dependent autofill have been removed.
- Gidget: keeps local POS and repair-assistant capabilities while removing the Railway-hosted API fallback.

## v0.5.78 (2026-08-11)
- Calendar Notes: uses collision-resistant IDs and authenticated Supabase Realtime sync so important daily notes remain available across Windows and Android installations.
- Daily Look / Journal: includes each day's important notes and adds a mobile Technician Journal that gathers calendar notes, work-order repair journals, and sale notes without changing the underlying records.
- Notes Layout: adds a wide two-pane desktop notes workspace with a compact touch-friendly mobile layout for selecting and reading multiple notes from one day.
- End of Day: makes unclosed-ticket lists taller and opens their source work order or sale on double-click or Enter.
- Purchasing Cart: clears stale selection state after partial checkout, normalizes synced date values that previously crashed Cart/EOD, and adds URL price refresh with explicit Keep Changes or Revert review before any saved cost is updated.

## v0.5.58 (2026-08-09)
- End of Day Report: adds an Unclosed Tickets reconciliation section for diagnostic work orders, paid-but-unchecked-out work orders and sales, and Repair Complete client updates sent before a work order is closed.
- Responsive layout: bounds Calendar to the dynamic desktop viewport, reflows its controls and filters in portrait windows, and improves app-shell modal, loading, and table-pane sizing for narrow or rotated displays.
- Renderer: adds a standalone CSS module declaration so stylesheet side-effect imports resolve correctly in TypeScript.
- Windows Auto-Update: release retains the verified v0.5.55 update-install behavior without updater changes.

## v0.5.57 (2026-08-08)
- Calendar: keeps the Streaming/Content Schedule open while viewing or adding content entries, and keeps desktop month grids within the window with adjacent-month date positions blank.
- Mobile Calendar: adds a weekly date picker that jumps to the selected date's week, preserves the full cross-month week range, and adds compact per-day Important Notes access.
- Windows Auto-Update: release retains the verified v0.5.55 update-install behavior without updater changes.

## v0.5.56 (2026-08-08)
- Calendar: adds filterable Important Notes with a Notes button on every monthly date cell, hoverable note subjects, and daily subject/body note creation and management.
- Windows Auto-Update: release is packaged from the verified v0.5.55 updater baseline without changing its update-install flow.

## v0.5.55 (2026-08-08)
- Release checkpoint: packages the current GadgetBoy POS application with the original in-app updater behavior restored, for a clean manual-install baseline before the next update test.

## v0.5.54 (2026-08-08)
- Windows Auto-Update: restores the original in-app updater behavior used before the recent update-install experiments.

## v0.5.53 (2026-08-08)
- Windows Auto-Update: removes the external PowerShell handoff that could close the app without ever launching the installer. Updates now use electron-updater and NSIS's built-in update wait, replacement, and forced relaunch flow.

## v0.5.52 (2026-08-08)
- Notifications: removes the redundant Close button; the existing window X remains the single close control.
- New Client: places each contact-declined checkbox beside its phone or email field, with the Declined Info label directly beneath the checkbox.

## v0.5.51 (2026-08-08)
- Windows Auto-Update: waits for the GadgetBoy POS process to fully exit before starting the downloaded NSIS installer, preventing the installer from trying to remove files still held open by the running app.

## v0.5.50 (2026-08-08)
- Windows Auto-Update: uses a graceful, non-silent NSIS install handoff after the app begins closing, reducing installer failures when replacing older application files; the installer relaunches GadgetBoy POS after completing.

## v0.5.49 (2026-08-08)
- Inventory: products now use saved Product Types instead of Device Types, including dynamic type filters; new listings no longer default to Phone.
- Repair Parts: requires one Device Category and allows selecting multiple compatible devices within that category for a part.
- Toolbar: places End of Day Report beside Calendar and the compact unread-badged notification button, with responsive wrapping for narrow desktop widths.

## v0.5.48 (2026-08-08)
- Quick Checkout: replaces Quick Sale with an anonymous Sale or Repair checkout. Sale mode shows products; Repair mode searches the repair catalog and preserves part ordering details for End of Day purchasing.
- Client actions: keeps the larger New Work Order and New Sale buttons after client details are saved on both desktop and mobile.

## v0.5.47 (2026-08-08)
- EOD Purchasing Cart: adds a "Checkout Selected" button next to "Delete Selected" so a partial subset of a distributor's cart can be checked out, with an itemized receipt confirmation showing each item's cost before finalizing.
- Price fields: clicking into a price field now selects the whole value by default (like a standard text field); a second click places the cursor, and highlighting text before Backspace or typing now clears/replaces the whole value instead of only trimming the last digit.
- Part/product URL scraping: improves price-detection accuracy across vendor sites so it is less likely to pick up an unrelated price from the page.
- Android notifications: fixes Notification Settings getting stuck on "Saving..." if the cloud save stalled; notifications now show a branded subtitle, dismiss automatically when tapped, and use consistent icon/branding across all notification types.

## v0.5.46 (2026-08-07)
- Mobile Home: replaces the bottom New WO and New Sale shortcuts with Quick Sale, Add Client, and Search Client, and removes those duplicate actions from the side drawer.
- Line Item Editors: removes the redundant top Close button, keeps Cancel and Save together at the bottom, and closes Sales and Work Order editors automatically after Save.
- Consultation Editing: removes product-ordering controls from consultation line items, preserves an edited customer hourly rate, and calculates technician commission from saved hours rather than the amount charged.
- Custom Item URL Pricing: preserves technician-entered Sales and Work Order names while supplier URLs update cost, markup, and the resulting customer charge.

## v0.5.45 (2026-08-07)
- Consultation Client Updates: places the saved consultation's Update Client action directly beneath the client information on both desktop and mobile, matching the work-order workflow.

## v0.5.44 (2026-08-07)
- Consultations: saves and displays `At Shop Location` wherever an in-shop consultation address appears, including new calendar entries and consultation printouts, while normalizing older blank or In-Store values without changing real at-home addresses.
- Consultation Mobile Workflow: keeps Add New Client fields directly beneath client search, collapses them into the saved client card, removes the keyboard-blocking email suggestion list on that embedded form, and calculates the charge from hours while allowing a deliberate custom amount.
- Mobile Client Profiles: stacks New Work Order and New Sale, keeps history filters and tables inside the phone viewport, and places Save Client directly below Notes.
- Mobile Touch: verifies that a normal tap opens a record while a deliberate hold invokes the same context actions as desktop right-click.
- Recent Customers: hydrates names, phone numbers, and email addresses from the canonical customer record plus the latest linked work order so partial legacy ticket data no longer creates incomplete rows.
- Calendar: adds a larger native Notes field and an Expand Notes overlay that closes from the shaded backdrop.
- End of Day: groups daily payment, revenue, supplier, and ticket figures into a non-scrolling desktop overview with Open and Closed tickets side by side.
- Parts Inventory: allows one reusable part title to be assigned to multiple compatible device models and filters the repair part picker by the current device without overwriting it.
- Email Delivery: adds an authenticated Supabase email function for mobile and hosted client updates while retaining the existing desktop Gmail fallback.
- Distributor URLs: identifies known and generic distributor names locally from pasted order URLs even when product-page scraping is unavailable, so vendor entry no longer depends on Railway.

## v0.5.43 (2026-08-07)
- New Client Contact: requires a complete 10-digit phone number and complete email address before saving or continuing, with compact independent Declined choices beside Phone and Email; Alt Phone remains optional.
- Client Workflow Safety: blocks New Work Order and New Sale from opening until the new client passes validation and is saved with a real customer ID.
- End of Day Layout: moves Low Stock into the left desktop overview column, stacks it cleanly on mobile, and removes the duplicate full-width section beneath the report while keeping purchasing in the Cart window.

## v0.5.42 (2026-08-06)
- Ticket Item Accounting: saves work-order and sale item edits immediately, including supplier cost, quantity, distributor, order URL, markup, tax status, SKU, model, condition, notes, and reorder quantity, without adding ticket-only custom items to the permanent inventory catalog.
- End of Day Cart: adds distributor-wide and optional per-item estimated delivery dates, carries verified delivery details back to the source ticket, and mirrors expected arrivals into the synced calendar.
- Client Updates: gives sales and consultations their own update actions and delivery history, including product ordered, shipping delay, product arrived, consultation reminders, schedule-change approval details, confirmations, and completion notices.
- Consultation QR Codes: now download the consultation calendar event with a reminder one hour before the appointment instead of opening the repair update page.
- Calendar: keeps an existing entry's type fixed, displays consultation email and address details, enlarges desktop notes, and enriches consultation details from the synced client record.
- Mobile Clients: restructures Add Client and Search Client for phone-width fields and fixed-width name, phone, and email lists without horizontal overflow; consultation client creation stays focused on contact fields only.
- Reporting: separates parts charged, parts cost, and labor charged, and adds editable sales and consultation commission settings with exact per-technician allocations.

## v0.5.41 (2026-08-06)
- Android Notifications: makes the native permission handshake authoritative, recognizes permissions granted in Android Settings, and prevents Notification Settings from remaining stuck while checking.
- End of Day Cart: removes the duplicate bottom cart summary, adds View Invoice actions, and clearly identifies unpaid or partially paid work-order and sale items.
- Order Accounting: keeps supplier item cost, distributor, and order URL on each sale or work-order line item while leaving shipping, supplier tax, and checkout fees for End of Day checkout.
- Part Entry: automatically reads pasted order URLs when editing line items and fills available title, distributor, and base-cost details without requiring a separate scrape button.
- Parts Tracking: focuses the work-order section on order and delivery dates, tracking links, and delivery notes while preserving ordering details on the associated line item.
- Checkout: removes the redundant in-app close button from the standalone Windows checkout window while retaining the mobile close control.

## v0.5.40 (2026-08-06)
- End of Day Email: restores editable recipient and subject fields on Windows and Android, keeps report-content choices in the email window, and removes the old bottom settings dropdown.
- End of Day Settings: opens Daily Batch Settings as a focused window over EOD Report Email with the accounting cutoff, email schedule, daily email time, and current batch status.
- End of Day Accounting: uses the saved shop-local Batch Out time as the daily totals boundary instead of midnight.
- Batch Scheduling: catches up a missed cutoff exactly once, keeps Batch Out independent from manual email scheduling, and waits for verified Supabase access before marking a Windows batch complete.
- Android: records the accounting-day rollover while the app is active or next opened and keeps Batch Out Now as the explicit mobile backup export.
- Instructions: documents the cutoff, catch-up, email, and platform-specific Batch Out behavior.

## v0.5.39 (2026-08-05)
- Inventory / EOD: shows tracked parts and products at or below their saved threshold in a dedicated Low Stock section with Dismiss, View Item, and duplicate-safe Add MOQ to Cart actions.
- Inventory: renames Reorder Qty to MOQ / Reorder Qty, uses that saved quantity for low-stock restocking, and opens the exact inventory record from EOD on Windows and Android.
- Purchasing Cart: includes saved client tax in Charged totals and adds a distributor-level Tax Exempt option; non-exempt supplier carts calculate South Carolina's 8% sales tax separately from shipping and checkout fees.
- Responsive layouts: expands desktop EOD and inventory workspaces with denser accounting columns while preserving compact phone and tablet layouts, including landscape; Android taps keep the primary action and deliberate holds use the matching desktop right-click menu.
- Reporting: saves and displays base item cost, supplier tax, tax-exempt status, additional costs, and the final verified supplier spend without treating client tax as profit.

## v0.5.38 (2026-08-05)
- End of Day: reorganizes the mobile header with prominent Cart and EOD Report Email actions, a full-width Batch Out action, and report sending contained inside the email window.
- Purchasing Cart: groups pending parts and products into compact expandable distributor carts with quantities, order links, additional checkout costs, payment warnings, and per-distributor totals.
- Purchasing Cart: adds URL-assisted and manual Part/Product entries, inventory restock entries, distributor memory, and a two-step verified checkout that records only carts actually paid.
- Purchasing Cart: adds distributor-level Select mode and confirmed deletion; linked work-order/sale items remain intact with a persistent paid-but-not-ordered warning and a Restore to EOD Cart action.
- Inventory: adds quantity-aware Add to Cart restocking and idempotent stock consumption so in-stock sale and work-order items deduct once without appearing as new supplier purchases.
- Reporting: separates transaction COGS from verified supplier cash spend, includes supplier purchase detail in period and month-end exports, and prevents supplier cost from being subtracted from profit twice.
- Cloud and backups: syncs supplier purchases, stock-consumption keys, inventory restock keys, and repair-to-inventory links through Supabase and includes purchasing records in protected backups.
- Mobile: adds touch hold behavior for desktop-style context actions without changing normal tap behavior.
- Notifications / Android: uses Capacitor Local Notifications as the primary Android permission handshake, retains the app bridge as a bounded fallback, and reveals notification choices only after the operating system grants access.
- Instructions: expands the bundled operating manual with the complete in-stock, order-required, manual purchasing, restock, verified checkout, and reporting workflows.

## v0.5.37 (2026-08-04)
- Notifications / Android: opening Notifications or its Settings page no longer starts a hidden permission request; Android is contacted only when the user explicitly selects Allow notifications.
- Notifications / Android: uses the official Capacitor Local Notifications permission API first, bounds every permission check, and retains the custom native bridge only as a fallback.
- Notifications / Android: suppresses startup consent only when the operating system confirms permission is granted, and presents a direct Open device settings action when Android has already blocked further prompts.

## v0.5.36 (2026-08-04)
- Notifications: treats notification consent as a permanent device decision instead of tying it to the installed app version, preventing the authorization prompt from returning after updates.
- Notifications: verifies the operating system's current permission during startup and silently records already-approved devices while preserving manual access to notification settings.

## v0.5.35 (2026-08-04)
- Notifications / Android: replaces the legacy permission callback with Android's Activity Result permission launcher so a fresh installation reliably presents the operating-system notification prompt.
- Notifications / Android: reads Android's actual permission decision flags, immediately identifies devices that previously blocked notifications, and provides the app-settings route instead of waiting indefinitely for a dialog Android will no longer show.
- Notifications / Android: sends permission results through Capacitor's native event bridge and independently polls native status as a fallback so the authorization screen always resolves to allowed, denied, or settings-required.

## v0.5.33 (2026-08-04)
- Notifications: establishes a per-device authorization baseline so Windows and Android only alert for work orders and sales created after notifications were enabled, while older synced records remain available without generating stale alerts.
- Notifications: routes in-app and native notification selections to the associated work order, sale, customer, technician schedule, or exact calendar entry on both Windows and Android.
- Notifications / Android: prioritizes the native Android permission handshake, serializes concurrent permission requests, and retains the Capacitor fallback without leaving the authorization screen waiting indefinitely.
- Sales Product Picker: adds a compact desktop catalog with search, category, condition, and availability filters plus a touch-friendly mobile layout.
- Sales Product Picker: allows temporary quantity, stock, description, price, cost, condition, category, and ordering edits for the current sale without changing the permanent inventory record.
- Sales: preserves inventory links and stock metadata when a catalog product is added so checkout and reporting continue to use the selected product correctly.

## v0.5.32 (2026-08-04)
- Sales Product Picker: replaces the desktop Admin editor with the dedicated saved-product picker, keeps permanent Add Product controls Admin-only, and keeps the selection action visible without scrolling.
- Sales Product Picker: builds the sale line directly from the selected inventory record so description, pricing, internal cost, stock state, vendor details, and ordering URL reliably transfer into the sale.
- Products Admin: collapses the Reorder section by default so the product form opens at a practical height while retaining all distributor, SKU, quantity, and URL controls.
- Quote Generator: removes unstable website autofill and restores the confirmed-spec AI prompt built only from technician-entered fields.
- Quote Generator: adds a free local Generate Sales Summary action through Gidget, preserves Copy AI Prompt as a fallback, retains numeric specifications, excludes private pricing fields, and prevents indefinite loading with a bounded timeout.
- Client Updates: queues protected email content in Supabase and lets the authenticated shop POS deliver it using the existing encrypted Gmail App Password, avoiding a paid email provider or Google Cloud Console setup.
- Client Updates: records queued, sending, sent, and retry states while preserving ticket status updates and delivery history across Railway, Supabase, Windows, and Android.
- Notifications: adds first-run notification consent UI and strengthens native Windows and Android authorization handling without blocking access to the app.

## v0.5.31 (2026-07-31)
- Client Updates: adds bounded Railway/Gmail delivery timeouts, always unlocks update actions after failures, keeps retries available, and refreshes local/cloud status without blocking the update window.
- Client Updates: preserves delivery history and clearly distinguishes a saved ticket status from an email delivery failure.
- Technicians: restores permanent Supabase creation, editing, passcode storage, and deletion through admin/manager-scoped profile policies and admin-scoped credential policies.
- Technicians: uses the stable technician legacy ID for cloud upserts so changing an email cannot create a duplicate or make a technician disappear on another installation.
- Technician Analytics: adds per-technician performance views based on saved work orders, sales, and consultations without changing source records.
- Mobile Technicians: restructures technician cards and editing controls for phone-sized screens while retaining the established desktop layout.
- Notifications / Android: adds a native Android 13+ permission request/result handshake, remembers denied state, reveals in-app notification preferences only after approval, and rechecks permission after returning from system settings.
- Notifications: prevents the notification panel from remaining on "Checking..." and keeps the settings screen available across Android, mobile preview, and desktop.
- Instructions: expands and restyles the bundled POS manual with the current technician, notification, update, and troubleshooting workflows.

## v0.5.30 (2026-07-29)
- Notifications / Android: uses Capacitor Local Notifications as the primary Android 13+ permission request so the operating-system prompt returns directly to the app.
- Notifications: removes the minute-long permission polling path and adds bounded checks, retry guidance, and a native bridge fallback that cannot leave Settings stuck on "Checking...".
- Notifications / Windows: keeps native Electron authorization independent from the technician's alert toggle and revalidates native Windows toast delivery.

## v0.5.29 (2026-07-29)
- Notifications / Android: requests Android 13+ notification permission through the native activity and waits for the operating-system response before revealing device alert preferences.
- Notifications / Windows: routes authorization and delivery through Electron's native notification service, remembers device authorization, and displays a confirmation toast when notifications are enabled.
- Notifications: configures Electron notification permission handlers, keeps browser fallback delivery, and adds a repeatable Windows native-toast release check.
- Calendar Desktop: replaces the compact mobile-style Streaming / Content Schedule with a wide seven-column weekly production planner.
- Calendar Mobile: preserves the compact vertical seven-day schedule and prevents horizontal overflow on phone-sized screens.

## v0.5.28 (2026-07-29)
- Instructions: adds a comprehensive versioned operating manual covering Windows and Android workflows, client and work-order handling, parts, inventory, checkout, reporting, backups, updates, security, and troubleshooting.
- Windows Installer: adds an optional Instructions selection that places the current manual in Documents and creates a desktop shortcut.
- Windows / Android Updates: adds a Download Instructions checkbox and retrieves the PDF from the same versioned GitHub release as the platform installer.
- Calendar: syncs calendar entries through Supabase across devices, enables Realtime delivery, preserves tracking URLs, and adds a 30-second visible-screen refresh fallback.
- Calendar Mobile: adds a compact weekly layout, current-day emphasis, week navigation, and a dedicated Streaming / Content Schedule.
- Notifications: repairs native permission and settings loading across Windows and Android and exposes device-specific notification choices after authorization.
- QR / Client Updates: records ticket update history, sends configured customer email updates, and provides Android text-message handoff without changing client data.
- Quote Autofill: improves device-type detection, model-specific fields, image selection, variant/condition handling, timeout recovery, and editable generated summaries.
- Sales Mobile: restructures the sale editor for touch screens with a client summary, responsive item cards, paired order dates, sale-specific print and checkout actions, and reliable loading of existing sale data.

## v0.5.17 (2026-07-21)
- QR / Client Updates: sends authenticated repair and sale status emails through Railway to the customer's saved email address and reports delivery failures instead of claiming success.
- QR / Client Updates: adds a protected per-ticket History view with timestamps, recipients, technician messages, estimated dates, and sent or failed delivery status.
- Sales: restores sales-form QR codes, saves new sales before printing, and provides sale-specific Pickup Reminder, Product Ordered, Product In Shop, and custom update actions.
- Cloud Security: stores update history behind Supabase row-level security and keeps Gmail credentials exclusively in Railway server variables.
- Mobile / Desktop: supports authenticated cross-origin update delivery from installed apps and improves unsaved-client New Work Order and New Sale actions without changing saved-client layouts.

## v0.5.16 (2026-07-21)
- Work Orders: fixes populated mobile tickets opening as blank forms by preserving the modal payload through React's safety render.
- Work Orders: repairs Add Product on desktop and Android with a product-only picker, complete inventory metadata, explicit item limits, accurate linked-sale totals, and immediate persistence of the Sale link back to the work order.
- Parts Ordering: removes the manual Scrape action; pasting or committing an Order URL now reads the page automatically, fills available title/vendor/cost fields, applies the default 10% markup, and creates a pending part line when needed.
- Parts Ordering: normalizes common phone and tablet part titles into consistent inventory-friendly names while retaining useful quality and compatibility details.
- Clients: adds a compact client overview with editable contact card and grouped work-order, sale, consultation, and quote history; quotes and consultations can create searchable clients even without a completed sale.
- Mobile: improves client search/add layouts, work-order phone actions, calendar views, and product selection sizing for touch screens.
- Integrations: removes the unfinished Clover and Twilio settings, checkout, messaging, routes, and renderer bridges while preserving existing transaction and customer data.

## v0.5.15 (2026-07-19)
- Inventory: separates Products and Repair Parts with a blue Products toggle, green Add Part action, vendor memory, device type/model fields, stock controls, and a red saved Order URL button.
- Vendors: adds separate Product Vendor and Parts Distributor management, including wholesale/consignment settings, vendor share, tax exemption, and contact details.
- Repairs: replaces duplicate ordering fields in Devices/Repairs and Repair Selection with a shared searchable inventory-part picker while retaining per-work-order dates, order state, and shipment tracking.
- End of Day: adds selectable paid-and-ordered rows that sync part order status back to each work order and send confirmed client email updates where email delivery is configured.
- Reporting: records vendor terms with sold items so historical vendor payout, internal cost, revenue, and profit calculations remain tied to the facts saved at sale time.
- Mobile: keeps customer search columns within phone width and adds non-destructive health checks in Data Tools.

## v0.5.12 (2026-07-18)
- Android Updates: checks the system install-source permission before opening an APK, resumes installation after permission is granted, and dismisses the in-app prompt once installer handoff begins.
- Android Releases: verifies the APK application ID, version, signature, and signing-certificate continuity before publishing so updates install over the existing app.
- Work Orders: clarifies that diagnostic fees remain non-refundable and labor refunds may be declined or issued partially based on work performed and repair circumstances.
- Railway: adds a production build contract that publishes distinct desktop and mobile web entry points together and checks runtime configuration health before deployment completes.
- Railway: serves the real mobile entry point instead of rewriting `/mobile.html` to the desktop SPA fallback.
- Railway: restores the required public Supabase runtime variables and corrects the production domain target from port 3000 to the service's assigned port 8080.
- End of Day: locks the closeout overview and its email to the current local calendar day, refreshes automatically after midnight, and keeps monthly totals and historical filters in Reporting.
- Reporting: removes the daily batch email action so EOD is the single place technicians configure, review, and send the daily closeout.

## v0.5.11 (2026-07-18)
- Parts Ordering: records distributor, internal cost, adjustable markup, order-required status, supplier tax treatment, and order state on each work-order part.
- Parts Ordering: changes the default part markup to 10% while retaining 5% increments and custom percentage entry in Devices/Repairs and Repair Selection.
- Parts Ordering: keeps in-stock parts out of the purchase queue and turns pasted distributor URLs into saved, openable ordering links with scraped title, vendor, and cost details.
- End of Day: adds direct desktop and mobile entry points with labor, parts, products, payment, check-in, closeout, cost, tax, and margin summaries.
- End of Day: adds a parts-to-purchase queue with distributor links, payment verification indicators, and explicit warnings for missing costs.
- End of Day: adds saved report recipients and a concise email flow, with desktop sending and a prefilled mobile email fallback.
- Notifications: opens notification settings as a dedicated window and clarifies the device authorization flow before showing alert choices.

## v0.5.10 (2026-07-17)
- Android Updates: signs every release with one persistent production certificate so future APK updates install over the existing app.
- Railway: binds the hosted web server to Railway's assigned `PORT` and fails clearly when required runtime configuration is missing.
- Work Orders: clarifies that an unusable ordered part may be refunded while the applicable $25 or $50 diagnostic fee remains non-refundable.

## v0.5.9 (2026-07-17)
- Windows Updates: pins the production GitHub release feed explicitly and repeats update checks while the POS remains open.
- Mobile Updates: retries temporary Android WebView network failures, avoids cached release responses, and checks the release list before the latest-release fallback.
- Release Safety: adds an automated feed verifier for version ordering and required Windows/Android update assets.

## v0.5.8 (2026-07-17)
- Parts Ordering: adds URL scraping for part title, cost, device/category details, condition, and source information in the Devices / Repairs workflow.
- Parts Ordering: adds Save Part and Save Repair actions so technicians can retain reusable supplier and repair-template information.
- Work Orders: refreshes Parts Tracking with order and delivery dates, saved Order URL and Tracking URL buttons, clear/save controls, and mobile-friendly sizing.
- Client Search: makes duplicate detection and search agree across Clients, Consultations, and Quotes, including full names, formatted phone numbers, alternate phones, and email.
- Client Search: pages complete Supabase customer reads so older clients remain searchable as the database grows.
- Railway / QR: validates public Supabase runtime settings, supports standard Railway variable aliases, and loads runtime settings before the mobile web app starts.

## v0.5.7 (2026-07-17)
- Notifications: adds per-device notification permission and settings for mobile/Android, with a checklist for consultation reminders, new work orders, new sales, parts delivery, calendar events, technician schedule changes, and Daily Look.
- Notifications: schedules native Android consultation reminders with selectable hour lead times and keeps browser/Windows notification fallback support where available.
- Notifications: syncs work order, sale, calendar, and technician changes into the notification system on both desktop and mobile.
- Mobile: keeps Notification Settings inside the mobile modal shell without an extra internal Close button.
- Android: registers the Capacitor local notifications plugin so future APK builds can request OS notification permission.

## v0.5.6 (2026-07-17)
- Login: replaces the visible email/password form with a shop username/PIN form and routes the configured `Gadgetboyz` username to a hidden Supabase Auth email.
- Login: blocks direct email entry in the POS login screen so the shop alias is the only visible sign-in path.
- Technicians: prevents Supabase login-only staff profile rows from appearing as assignable technicians in consultation, work-order, calendar, reporting, and mobile filters.
- Mobile: hides the Supabase profile name from the side drawer and shows a generic shop session label instead.
- QR / Client Updates: adds cloud-backed QR status tokens so status/client update links can resolve through Supabase instead of relying only on the desktop status server.
- Work Orders: adds the in-app Update Client panel and keeps customer/status QR flows available from desktop and mobile app screens.

## v0.5.5 (2026-07-16)
- Mobile Updates: fixes Android version comparison so newer patch releases are detected correctly after this update.
- Quick Sale: supports multiple items in one checkout using the same item table and product picker as the Sales form.
- Quick Sale: saves full sale item arrays so receipts, reports, sync, and backups treat quick sales like normal sales.
- Printouts: reduces sales/work-order QR size and widens client info so Date/Time and customer rows stay on one line.
- Devices/Repairs: shows recovered service types from saved repair items in the Service Types editor.

## v0.5.4 (2026-07-16)
- Mobile: removes the bottom-bar Sync button because Sync Now already lives in the side menu.
- Mobile: centers the top GADGETBOY POS title and keeps the version label grouped with POS when the title stacks.

## v0.5.3 (2026-07-16)
- Mobile Updates: adds an Update button above Sync Now in the mobile side menu when a newer Android APK is available.
- Mobile Updates: shares one update checker between the popup and side-menu button so both find the same latest APK release.
- Android: downloads the APK through the native app bridge and opens Android's installer prompt to finish the update.

## v0.5.2 (2026-07-16)
- Repairs: restores the desktop New Item / Repair Selection layout while keeping the compact mobile repair table only on mobile.
- Repairs: makes Diagnostic show first, Additional Fees second, and all other repair categories alphabetically in lists and filters.
- Repairs: fills missing category filters from the saved repair items when the category/type list is incomplete.
- Mobile: lets the top GADGETBOY POS title wrap onto two lines instead of cutting off on narrow screens.
- Work Orders: restores the desktop work order creation sidebar layout while keeping the mobile title card and status/date menu on mobile.

## v0.5.1 (2026-07-16)
- Work Orders: reworks Parts tracking with side-by-side order and estimated-delivery dates, a cleaner mobile/desktop layout, and internal-only order notes.
- Work Orders: turns saved Order URL and Tracking URL values into openable buttons after paste, Enter, blur, or Save.
- Work Orders: keeps selected repair order-source URLs flowing into Parts tracking without adding website-scraper logic to work orders.
- Work Orders: hydrates linked customer details when opening existing work orders so synced preview records retain client information.
- Mobile Preview: allows the drawer preview menu to close and reopen while testing the full mobile interface.

## v0.5.0 (2026-07-16)
- Inventory: adds markup-aware part pricing with a default 5% markup and quick presets for 5%, 10%, 15%, 20%, and 25%.
- Inventory: turns saved vendor/order URLs into an Order URL button after paste, Enter, blur, or save, with Edit and Clear actions.
- Supabase: adds markup sync fields for inventory products and repair templates so part pricing settings persist across devices.
- Backup Import: preserves inventory and repair-template markup percentages during Supabase backup imports.
- Repairs: applies the same order URL button behavior to repair templates and selected work-order repair parts.
- Mobile: fixes the Devices/Repairs window so the catalog list, form, and Repair Selection table fit and scroll correctly on phone screens.

## v0.4.99 (2026-07-16)
- Mobile Updates: finds the newest GitHub release that includes an Android APK instead of ignoring updates when the latest release asset set is incomplete.
- Mobile Updates: shows a dimmed in-app update prompt after login with Update now and Skip for now actions.
- Mobile Updates: makes Skip for now apply only to the current open app session so the reminder returns on relaunch.

## v0.4.98 (2026-07-16)
- Inventory: refreshes the Parts/Products window with compact catalog-style rows, search-bar filters, low-stock filtering, and add/edit controls in the detail pane.
- Inventory: adds multi-device associations for shared repair parts like universal power cables.
- Supabase: adds product inventory metadata fields for item type, part category, distributors, reorder links, and associated devices.
- Admin: moves Local Backup into Data Tools, removes separate Products navigation on mobile, and hides Clover/Twilio setup from the visible desktop/mobile menus.
- Notifications: merges notification settings into the Notifications window behind a Settings toggle.
- Reporting: defaults reports to daily totals, keeps date ranges explicit, and adds month-end commission/audit reporting.
- End of Day: separates parts charged from parts cost, and products sold from product cost, using saved internal-cost values only.

## v0.4.97 (2026-07-16)
- Mobile: refines the Repair Selection table so Device, Category, Repair, P, L, and Total all fit inside the visible phone/tablet width.
- Mobile: moves Repair Selection filters behind the three-line search control and keeps Show All inside that filter panel.
- Mobile Updates: opens Android APK downloads through the native Android browser/download handler and keeps the APK version synced to the release version.
- Work Orders: strengthens client snapshot handling so newly created work orders retain visible customer details while cloud sync catches up.
- Work Orders: adds a Repair Journal flow for archived internal notes tied to each work order.
- Parts Tracking: improves order URL handling with saved/openable order links and selected-repair URL carryover.
- Repairs: improves Repair Selection naming and mobile repair form layout for touch use.

## v0.4.96 (2026-07-13)
- Mobile: reorganizes the side menu into priority actions, Client Database, Technician Tools, and Admin sections.
- Mobile: refreshes the main toolbar with the GadgetBoy logo, larger purple brand text, version label, slimmer header, and search-bar filter menu.
- Mobile: improves touch behavior with draggable action sheets, full-screen modal close buttons, and responsive quote layouts for portrait and landscape.
- Quotes: adds Sales/Repairs switching, Search Client/Add Client actions, selected-client summaries, and saved quote refresh events on desktop and mobile.
- Supabase: adds saved quote cloud sync support so quote records are included with synced/backed-up shop data.
- Backup: includes Saved Quotes in the local backup selection list.

## v0.4.95 (2026-07-13)
- Mobile Updates: checks for a newer Android APK after mobile login and cloud session readiness.
- Mobile Updates: rechecks when the Android app comes back to the foreground or reconnects online.
- Mobile Updates: Skip is now skip-for-now for the current app session instead of hiding that APK version forever.

## v0.4.94 (2026-07-13)
- Mobile: uses the same GadgetBoy logo as the desktop app for Android launcher icons.
- Tooling: Android launcher icons are regenerated from `public/logo.png` during the existing icon generation step.

## v0.4.93 (2026-07-13)
- Mobile: replaces the Android APK desktop-shrunk view with a touch-first mobile home screen.
- Mobile: adds drawer navigation, bottom quick actions, card-based work order/sale lists, and long-press action sheets.
- Mobile: opens POS windows inside a full-screen mobile shell while keeping the desktop app layout unchanged.
- Release: GitHub release titles now use the version tag number.

## v0.4.92 (2026-07-13)
- Mobile: adds a Capacitor Android APK build target with a mobile-only entrypoint and Android project.
- Mobile: adds a Supabase-backed mobile data bridge so Android uses the same shop cloud data as desktop/web after login.
- Mobile Updates: Android checks the latest GitHub release for the Android APK asset, while Windows keeps using the Windows auto-update feed.
- Release: prepares the mobile release assets so GitHub releases can include the Windows setup installer and Android APK.

## v0.4.88 (2026-07-13)
- Auth: prevents same-user session refreshes from briefly clearing the staff profile and showing the login screen again.

## v0.4.87 (2026-07-13)
- Supabase: suppresses the unused Realtime WebSocket transport warning in Electron main-process cloud database checks.

## v0.4.86 (2026-07-13)
- Startup: replaces blank auth/cloud wait states with visible status screens.
- Supabase: falls back to cached local data with a warning instead of blocking the app on cloud session errors.

## v0.4.85 (2026-07-13)
- Windows: removes the startup loading overlay for every child-window route so New Work Order and related windows render normally.

## v0.4.84 (2026-07-13)
- Supabase: waits for the cloud session and verifies cloud database access before showing the main POS tables.
- Supabase: successful cloud reads now seed the local cache so recently loaded records remain visible offline.
- Offline Sync: local add/update/delete actions now queue Supabase writes when offline and replay them after login/network returns.

## v0.4.83 (2026-07-13)
- Clover: checkout now sends the applied payment amount to Clover instead of the original selected due amount.
- Clover: successful Clover card handoff now saves the POS checkout result automatically.

## v0.4.82 (2026-07-12)
- Auto Update: installs downloaded updates silently instead of showing the setup wizard.
- Auto Update: increased the update progress window height so the action buttons are not clipped.

## v0.4.81 (2026-07-12)
- Clients: added a duplicate-client failsafe before creating a new client from Customer Overview or Consultation Booking.
- Clients: warns when first/last name, matching phone field, matching alt phone field, or email already exists.
- Clients: duplicate warning can open the existing client info window without creating another record.

## v0.4.80 (2026-07-12)
- Auto Update: replaced the silent update download flow with a GadgetBoy-styled progress window.
- Auto Update: shows download progress, install-ready state, applying-update state, and visible failure details.
- Auto Update: keeps Skip for Now behavior so skipped updates are offered again on the next launch.

## v0.4.35 (2026-06-06)
- Calendar: Daily Look consultations now include direct actions to open the linked consultation sale and customer info.
- Calendar: consultation event edit popup now also includes "View Consultation Sale" and "View Client Info" actions.
- Printouts: work order release/receipt and sales receipt flows now consistently show full client contact details (name, phone, email, and alt phone when available).
- Quick Sale: window now closes automatically after a successful checkout flow.
- SMS: Customer Overview includes in-window Twilio SMS settings and direct Text Customer sending.

## v0.4.30 (2026-05-11)
- Performance: reduces intermittent UI freezes during autosave bursts by streaming DB writes in the main process (keeps the event loop responsive during large JSON saves).
- Performance: prevents customer list reload thrash across windows during frequent autosaves (per-window caching + subscriptions refresh only on `customers:changed`).
- Performance: faster client lookup while typing in Quote Generator and Consultation booking (precomputed search index + early-exit limiting).

## v0.4.29 (2026-05-05)
- Consultation: fixed untypeable Consultation Details fields caused by the customer search dropdown overlaying the form.
- Tooling: removed deprecated TypeScript config options to clear VS Code Problems diagnostics.

## v0.4.28 (2026-05-02)
- Work Order Checkout: add-on products are treated as Parts during checkout (Parts/Labor selection stays available), and payments correctly apply to the attached product sale.

## v0.4.27 (2026-04-30)
- Autosave: prevents lockups by avoiding back-to-back queued saves while typing (queued saves now respect the idle/debounce window).
- Customers: improves data entry with auto-capitalized names, phone auto-dashes + format warning, and common email domain suggestions.
- Work Orders: autosave runs after a longer idle window to reduce typing lag.

## v0.4.26 (2026-04-30)
- Startup: shows the loading screen immediately on launch (no gray flash before the app renders).
- Customers: autosave is more efficient and avoids save-loops/hangs during data entry (saves serialize and only run after actual edits).
- Work Orders: autosave triggers after a longer idle window to reduce typing lag.
- Main screen: replaced Customer Search with separate Add Client and Search Client buttons.

## v0.4.25 (2026-04-24)
- Quote Generator: Create Sales form flow — select items via checkboxes and auto-create a Sales ticket for the selected customer (opens the Sale ticket for checkout).
- Performance: main-process DB writes are faster (compact JSON) and collection change events are coalesced to reduce UI freezes during frequent autosaves.
- Performance: Recent Customers no longer reloads/sorts the full Work Orders list on every change (bounded query + debounced refresh).
- Calendar: autosave no longer uses expensive deep JSON equality for change detection.
- Reports: Trends bars now scale with headroom so the biggest bar isn’t always maxed-out.
- Reports: Popular devices now groups by specific device/model (e.g., “PS5”) instead of the broad category.
- Repairs: fixed Devices/Repairs edit form lock (fields stayed untypeable after Cancel/Delete) and added Enter-to-save workflow across key forms.

## v0.2.50 (2026-03-07)
- Interactive Quote: signature + date fields are inline on the page (no popup/overlay).
- Interactive Quote: Finalize reliably downloads the signed PDF in one step.

## v0.2.31 (2026-02-20)
- Fix: Quote Generator print/PDF build now compiles cleanly after adding Customer Email.

## v0.2.30 (2026-02-20)
- Quote Generator: added Customer Email field to client info.
- Send Quote Email: email body is edited/saved from the Send Email window; Email Settings is now focused on Gmail app password + sender name.
- Send Quote Email: recipient auto-prefills from Customer Email when available.

## v0.2.29 (2026-02-18)
- Added Quick Sale button next to Generate Quote.
- Quick Sale: enter description + amount, optionally apply 8% tax, then checkout using the standard Cash/Card checkout modal.
- Quick Sale saves into Sales list as "Quick Sale" with the amount collected.

## v0.2.28 (2026-02-17)
- Performance hotfix: main-process JSON DB now uses an in-memory cache to avoid repeated synchronous read/parse.
- Performance hotfix: DB writes are coalesced and written asynchronously to reduce UI lag during frequent saves.
- Performance hotfix: DB debug logging is now gated (prevents massive base64 image payloads from stalling the app).

## v0.2.27 (2026-02-17)
- Custom PC Storage UI: renamed Storage to Primary Storage and updated labels to match other dropdowns.
- Primary/Secondary/Additional storage: one "Add Image" button (up to 2 images) + consistent card layout.
- Secondary/Additional storage: now supports pricing and prints as separate line items.

## v0.2.26 (2026-02-16)
- Custom PC Storage: added the missing Storage price field.
- Custom PC Storage: primary storage now supports 2 images (and the image controls no longer disappear when enabling secondary storage).

## v0.2.25 (2026-02-16)
- Email Settings: you can now edit and save the default email body text used when sending quotes.

## v0.2.24 (2026-02-17)
- Custom PC interactive HTML: "Preview / Download" now generates a PDF download instead of opening the print dialog.

## v0.2.23 (2026-02-16)
- Custom PC quote builder: support multiple images per part category.
- Storage UX: optional secondary storage section + multiple secondary drives.
- Print Preview + HTML: Custom PC parts checklist now mirrors the entered parts list and includes a client notes area.
- Terms and Conditions: expanded slightly for parts availability/price changes and client-caused damage.
- Email/HTML sending: interactive HTML no longer depends on local logo files (safer when emailed as an attachment).

## v0.2.16 (2026-02-14)
- Work order checkout: "Close window" now closes only non-main windows (prevents the whole app from exiting).
- Customer Receipt: print receipt now auto-prints to the default printer (silent) on checkout.
- Customer form: swapped Phone and Email field positions.

## v0.2.17 (2026-02-14)
- Customer Receipt header: client name/phone/email now populate correctly for auto-printed receipts after checkout.
- Customer Receipt: invoice number now preserves leading zeros (matches work orders).

## v0.2.15 (2026-02-13)
- Main screen pagination: bottom Prev/Next controls are now wired to real paging state.
- Pagination is consistent across All, Work Orders, and Sales lists (25 rows/page).

## v0.2.14 (2026-02-13)
- Main screen (All view) unified list: paginate to 25 rows per page so the home list never becomes a long scroll.

## v0.2.13 (2026-02-13)
- Main screen work orders list: paginate to 25 rows per page (prevents long scrolling as the list grows).

## v0.2.12 (2026-02-13)
- Customer Receipt: embed logo as a data URL for reliable PDF export.
- Customer Receipt: updated device/details block ordering to match other printouts and reduced layout forcing that could create an extra blank PDF page.

## v0.2.11 (2026-02-07)
- Sales + work orders: required-field warnings are now non-modal (yellow banner + red markers) and use a 2-click confirm flow (warn on first click, proceed on second).
- Save now closes the Sale/Work Order window after a successful save.
- Removed duplicate Reports button from the main toolbar.
- Product picker windows are now parented to the invoking window (fixes Sales → New item bringing the main window to front).

## v0.2.10 (2026-02-07)
- Sale items now store an optional product URL with a quick "Go to product" action from the items table.

## v0.2.9 (2026-02-06)
- Re-release to ensure CI/CD publishes latest print layout and batch-out backup updates.

## v0.2.8 (2026-02-05)
- Batch Out backups: configurable daily time with auto backup to ProgramData/backups plus manual "Batch Out" control in EOD window; backups stored alongside last-run metadata.
- EOD settings now store batch-out preferences; renderer can see last batch-out timestamp and trigger backups directly.
- Release form device block condensed to three rows (Device/Description, Model/Serial, Password/Problem) for a tighter layout.
- Release form: Problem now has its own expanded box; parts/labor list compacted to give more room to the problem detail.

## v0.2.7 (2026-02-05)
- New End of Day window with autosaved settings, date-range summaries, and email sending; exposed via IPC/preload and toolbar shortcut.
- Toolbar polish: neon Generate Quote call-to-action on the left; Technicians, EOD, Calendar, and fullscreen controls grouped on the right.
- Customer Overview autosave now validates contact details, creates new customers when needed, and supports close-on-save behavior reliably.
- Work order child windows respect closeParent only for spawned dialogs; release form wording consolidated in the final block.

## v0.2.6 (2026-02-03)
- Keep release print to one page: two-column items when long, notes/checklist/terms/signature stay together.
- Show selected device category in the picker and feed it through to printouts.
- Technician lists refresh live (assignment dropdown, filters, tables, unified list) when new techs are added.

## v0.2.18 (2026-02-15)
- feat: notifications + daily look
- UI: lift sidebar print buttons

## v0.2.19 (2026-02-16)
- feat: quiet hours notification rules

## v0.2.20 (2026-02-16)
- feat: repair categories + additional fees

## v0.2.21 (2026-02-16)
- fix: devices/repairs edit UI + delete category

## v0.2.22 (2026-02-17)
- fix: clean up quote generator labels
- feat: right-click context menus for lists
- ui: tidy device category actions
- fix: stack source + url fields

## v0.2.41 (2026-03-07)
- Data Management + mobile quote fixes (v0.2.41)

## v0.2.42 (2026-03-07)
- No commits recorded.

## v0.2.43 (2026-03-07)
- No commits recorded.

## v0.2.44 (2026-03-07)
- fix(quotes): typed signatures auto-render while typing in Sign & Finalize popup
- fix(quotes): keep signature/date off the HTML view; apply them only to exported PDF

## v0.2.45 (2026-03-07)
- fix(quotes): Sign & Finalize button fallback wiring (inline onclick + delegated handler)

## v0.2.46 (2026-03-07)
- fix(quotes): pre-open signing popup on tap/click to prevent "Loading" dead-end

## v0.2.47 (2026-03-07)
- fix(quotes): stable global Sign & Finalize handler + init-wait (prevents stuck "Loading")

## v0.2.48 (2026-03-07)
- fix(quotes): prevent Sign & Finalize button HTML from breaking (quote-safe onclick)

## v0.2.49 (2026-03-07)
- fix(quotes): remove popup-based signing; Sign & Finalize now opens an in-page signature + date screen and downloads the signed PDF

## v0.4.3 (2026-04-02)
- No commits recorded.

## v0.4.4 (2026-04-02)
- No commits recorded.

## v0.4.5 (2026-04-04)
- Main screen: Status filter (Open/Closed) is now wired and filters correctly across Work Orders, Sales, and All views.
- Work Orders: Status display/logic now follows the ticket lifecycle status (open / in progress / closed) with safe fallback for older records.
- Quote Generator: “Print” + “Digital” buttons, Email Settings toggle for sending HTML vs PDF-only, and PDF emailing support.
- Customer Overview: Completed quotes now associate by customerId (prevents throwaway/manual entries from attaching to existing customers).

## v0.4.6 (2026-04-04)
- Send Quote Email: HTML/PDF toggle moved into the Send Email window (default: PDF only).

## v0.4.7 (2026-04-05)
- Performance: reduced UI lag while typing/filtering by deferring expensive table recomputations and removing per-row heavy lookups.
- Payments: Checkout now supports partial “Amount to apply” so you can split tender (ex: $50 cash then the remainder on card).
- UI: removed redundant top-right Close buttons on windows that already use the global floating ✕.

## v0.4.8 (2026-04-06)
- Performance: smoother typing in New Work Order by removing expensive deep comparisons from autosave.
- Consultation: client search now uses an in-memory customer cache (no repeated full DB loads while typing).
- Sales: reduced unnecessary recomputation of the shared work-order model while editing unrelated fields.

## v0.4.9 (2026-04-06)
- UI: modal windows reserve space so top-right actions no longer sit under the global floating ✕.
- UI: removed/hid redundant Close/Cancel buttons on windows that already have the floating ✕.
- Consultation: window opens larger and uses a fixed-height layout so the Book Consultation button is always reachable.

## v0.4.10 (2026-04-06)
- Print: Release Form now includes the Pattern Lock diagram on the printout.
- UI: Quote Generator HTML preview toolbar no longer overlaps the global floating ✕.
- UI: Quick Sale hides redundant Close/Cancel buttons when the floating ✕ is present.

## v0.4.11 (2026-04-06)
- Customer Overview: removed the Quotes filter button (quotes are shown only in the bottom Completed Quotes section).
- Customer Overview: Completed Quotes now shows only real saved quote PDFs (prevents debug/placeholder quote entries from appearing repeatedly).

## v0.4.12 (2026-04-06)
- UI: Customer Search and Customer Overview now show a top-right ✕ close button when opened as standalone screens (outside the modal shell).

## v0.4.13 (2026-04-06)
- Work Orders: Device Category and Device fields now accept the top dropdown match when you press Tab (auto-fills, then moves to the next field).
- Checkout: pressing Enter now triggers Save when the checkout form is valid.

## v0.4.14 (2026-04-06)
- UI: modal windows are scrollable again when content is taller than the screen (fixes Quote Generator bottom Save/Print actions being unreachable).

## v0.4.15 (2026-04-06)
- Work Orders: Device Category and Device dropdowns now support Arrow Up/Down to move the highlight and Enter to select (Enter defaults to the top match unless you navigate with arrows).

## v0.4.16 (2026-04-06)
- Performance: reduced input lag in Work Order and Sales windows (device/category typing no longer re-renders the whole window per keystroke; Sales item IDs are now stable so rows don't re-mount while typing).

## v0.4.17 (2026-04-06)
- Devices/Repairs: Clear no longer leaves dropdown popovers open over the form (inputs remain clickable/typable after clearing).

## v0.4.18 (2026-04-07)
- Reports: Batch Out email no longer includes backup details.

## v0.4.19 (2026-04-07)
- Reports: Batch Out timestamp in the email is stamped at send-time (manual + scheduled), so it always reflects when the email was actually sent.

## v0.4.20 (2026-04-07)
- Main screen: pressing Enter in the Work Order # filter now refreshes the list using the current filters.

## v0.4.21 (2026-04-07)
- Work Orders: Tab now selects the highlighted Device Category/Device option (Arrow keys or mouse hover), and no longer gets overwritten by the delayed blur commit.

## v0.4.22 (2026-04-07)
- Reports: manual Batch Out email now sends styled content as the email body (not an .html attachment).
- Reports: scheduled Batch Out email now respects the configured Batch Out time / Send time and no longer spams repeated reports.

## v0.4.23 (2026-04-12)
- Sales (Consultations): added a dedicated "Print Consult Sheet" printout containing all vital consultation info (client info, date/time, reason for visit, address, first-hour quote + driver fee) plus a large notes section for the tech.
- Reports: scheduled Daily Batch email no longer starts with a blank/duplicated section.

## v0.4.24 (2026-04-17)
- Checkout: added split tender payments (Cash + Card) and persists multiple `payments[]` entries so EOD totals reflect both cash and card.
- Checkout: Cash and Cash + Card now use a single "Cash received" field with automatic change/remainder calculations.
- Customer Receipt: printouts now include a Payments section showing cash received/change and card amount (supports Work Orders + linked retail add-on Sales).
- Work Orders: "Add Product" retail add-ons are tracked via a linked Sale, shown inline as read-only rows, and included in checkout allocation + customer receipts.

## v0.5.15 (2026-07-19)
- No commits recorded.
## v0.6.0 (2026-08-13)

- Gidget / Windows: serializes model setup so repeated setup or repair actions cannot open the same model download twice and trigger Electron remote-method errors.
- Gidget / Windows: safely cancels active downloads before repair, waits for Windows to release the partial model file, and returns actionable setup errors to the Gidget window.
- Gidget / Windows: resumes interrupted model downloads from their existing partial file instead of restarting the 2.5 GB transfer.
- Release safety: adds a real resumable model-download regression test to the release workflow and retains the packaged native CPU runtime verification.
## v0.6.1 (2026-08-14)

- Gidget / Windows: replaces the pre-Qwen3 native engine with the Electron 29-compatible `node-llama-cpp` 3.8.1 runtime, fixing `unknown model architecture: qwen3` and `Failed to load model` errors.
- Gidget / Windows: validates the complete 2.5 GB Qwen3 model by loading it, creating the production 4096-token context, and generating a real response before release.
- Release safety: corrects the packaged Gidget test so it executes extracted release code and fails if the native runtime test does not actually run.
- Existing verified Gidget downloads remain in place and are reused after updating.

## v0.6.3 (2026-08-14)

- Gidget startup: loads the verified local model in the background, serializes concurrent startup requests, and prevents the interface from remaining stuck on a status check.
- Gidget responses: adds native and renderer time limits so an interrupted or unresponsive generation returns an actionable message instead of displaying "Gidget is checking" indefinitely.
- Gidget chats: starts a fresh chat whenever the assistant opens and presents the latest 30 conversations in a ChatGPT-style left history drawer.
- Gidget history: supports desktop right-click and mobile press-and-hold deletion with confirmation while preserving authenticated, shop-scoped Supabase history.
- Release safety: makes the Gidget deletion regression check independent of Windows line-ending conversion.

## v0.6.23 (2026-08-21)

- Quick Checkout: keeps product and repair search controls fixed while making only their catalog lists scroll on desktop.
- Quick Checkout: keeps sale and repair detail fields, Save, totals, and Checkout visible instead of scrolling the entire window.
- Android: gives product and repair catalogs a larger, readable portrait layout with focused list and detail states, plus a side-by-side landscape layout.
- Feedback: fixes Delete so UUID entries are removed from local state and Supabase before the list refreshes, preventing deleted feedback from reappearing.

## v0.6.24 (2026-08-21)

- Inventory: Quick Checkout and regular Sale checkout now subtract the catalog product's sold quantity immediately after payment is recorded.
- Inventory: desktop and Android reconcile previously paid sales against tracked product quantities after Supabase connects and whenever Inventory opens.
- Inventory: paid-sale consumption markers sync through Supabase and remain permanent, preventing repeat startup or cross-device sync from deducting the same sale twice.
- Inventory: historical quantities stop at zero and flag a restock shortfall instead of becoming negative; unpaid and saved-only sales do not affect stock.
