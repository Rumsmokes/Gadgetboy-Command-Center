# EOD Cart and Repair Procurement Specification

## Goal

Make the Checkout Cart reachable from the mobile Command Center and make procurement an explicit repair-line decision, so an in-stock, salvaged, or client-provided part can never enter the purchase cart merely because it has a supplier URL.

## Rules

- Mobile Command Center exposes a visible **EOD / Checkout Cart** action and cart count.
- A work-order or sale line joins the purchase cart only when it is explicitly sourced as an order and is not suppressed or already purchased.
- A saved supplier/reorder URL is reference data, not proof that a part needs to be ordered.
- In-stock repair parts consume only their exact selected inventory variant when the applicable checkout is completed.
- Parent inventory groups are never decremented directly. The exact compatible child is required when a parent has variants.
- Client-provided and salvaged repair parts never affect the purchase cart. Salvaged/in-stock parts only change inventory when linked to a tracked child record.
- MOQ replenishment is manual from Inventory. It creates an inventory purchase row, not a customer repair purchase row.
- An ordered repair item can be placed in the cart without an order date; its order date is set when its EOD cart purchase is checked out.

## Scenarios to verify

1. PS5 Slim Disc HDMI selected from its PS5 inventory variant reduces only that child on eligible checkout.
2. An Xbox HDMI child cannot be selected automatically for a PS5 repair.
3. A linked inventory HDMI with a saved supplier URL does not create an EOD cart item.
4. A deliberately ordered HDMI creates an EOD cart item and keeps the work order awaiting parts.
5. Client-provided and salvaged parts do not enter EOD.
6. A manual Inventory MOQ reorder remains visible in EOD even without a work order.
7. Labor, diagnostics, and fees never enter EOD.
8. Existing cart entries derived only from a stale URL/in-stock state are suppressed without deleting the repair line.
