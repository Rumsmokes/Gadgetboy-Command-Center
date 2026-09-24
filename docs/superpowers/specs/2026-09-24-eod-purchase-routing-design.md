# EOD purchase routing and overdue-cart audit

## Purpose
Keep every paid or potentially paid customer part/product visible until it is ordered, delivered, or explicitly removed with an audit trail. The EOD cart, Needs Attention, Command Center routing, and client communication must describe the same state.

## Scope
This applies to work-order parts and sale products that require supplier ordering. It does not create purchase tasks for labor, diagnostics, additional fees, client-provided parts, salvaged parts, or in-stock inventory.

## Cart eligibility
A physical item requiring an order stays eligible for the EOD cart while its status is `needed` and it has not been explicitly removed from the purchase queue. An absent internal cost must not exclude it. Instead the cart renders a cost-required warning and Needs Attention flags the linked record. Existing ordered, received, and in-stock items remain excluded.

A queue timestamp is written once when the line becomes an EOD purchase task. Existing records without that timestamp fall back to their line-item, ticket, or checkout creation timestamp. The timestamp is retained until checkout, delivery, or explicit queue removal.

## EOD checkout and routing
When EOD checkout is confirmed, the exact selected line item is updated with order status, order date, ETA, supplier order data, and a purchase-queue completion timestamp. Linked work orders route to Awaiting Parts. Linked sales route to Product Delivery. Delivered items use the current delivery workflow and immediately leave the outstanding purchase cart.

## Client communication
Every EOD checkout starts as Internal only. The operator can opt in per selected item to Send client update. Internal-only checkout records the order event, changes ticket routing, and refreshes the Command Center without sending email or text. Opted-in items use the existing client-update delivery path and record delivery status in history.

## Needs Attention
For invoices created on or after the existing audit start date, Needs Attention adds explicit purchase reasons:

- Paid/partially paid order-required item is missing from the EOD cart.
- Order-required item has no supplier cost.
- Order-required item has no order URL where a URL is required.
- Item has remained queued for purchase for more than 24 hours without EOD checkout.
- An item was explicitly removed from the cart while payment may have been taken.

Each reason opens its linked ticket, with the EOD cart available as the remediation destination. These reasons are removed immediately once the relevant item reaches ordered, received, delivered, or in-stock state.

## Data synchronization and safety
The line-item fields use the existing synced ticket records. No client messages are sent from persistence or refresh operations. A cart checkout writes item state before refresh, and the Command Center derives its state from the saved item state rather than an optimistic local-only queue.

## Verification
Regression coverage will prove: paid/no-cost items remain in cart; ordered items leave it; overdue queued items appear in Needs Attention after 24 hours; internal-only checkout does not invoke client delivery; opted-in checkout does; and work-order/sale routing changes immediately after persisted checkout.