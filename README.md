# Ten × You — Offline Sales + Billing (Vercel)

One app, two halves, behind the same "Howzat?" team password:

* **Sales** (Overview, Team members, Dealers, Products, Dealer Lens): from ERPNext. One shared snapshot is kept in the database and pulled again at most every 2 hours (also billed quantities for linked orders). Top right shows **ERP last refreshed** and a **Refresh now** button that pulls immediately for everyone.
* **Billing**: the offline order-to-bill workflow:
  1. **New dealer**: on a dealer's first order the team member adds their details once (GSTIN, mobile, billing/shipping address). Every order after that, they pick the dealer from their list.
  2. **New order**: search a product, type quantities straight across the size run, and enter the price (incl. GST). **Or** download the Excel template, fill it and upload it. Unknown SKUs, bad quantities and missing prices are flagged for fixing; nothing is submitted until they're cleared.
  3. **Billing desk** (backend): every submitted order in one list. Select one or many → **Create billing sheet**, which downloads the exact *Saleor Bulk Order Import – B2B* CSV. Upload it to ERP as usual.
  4. **Link ERP order ID**: enter one or more front-end order IDs (5–6 digits). The app pulls them from ERP (`custom_saleor_order_no` on B2B Sales Orders) and checks them:
     * not found or cancelled → blocked
     * different customer, or already linked to another order → flagged, and needs a tick to confirm (with a note)
  5. **Order tracker**: Ordered vs Billed vs Pending per order and per SKU, refreshed from ERP every 20 min (or on demand). When an ERP order covers several app orders, billed quantity is split oldest-first, and anything billed that wasn't ordered shows as "extra". The backend can **close the pending quantity** with a reason (e.g. out of stock).
* **Entry:** after the password, pick **Billing** or **Sales dashboard** (switchable from the top bar).
  * **Sales dashboard** needs no name and shows everyone's numbers — billed sales (ERP sales orders, net of returns) and under picking only, never orders that are merely placed: Overview, Team members, Dealers, Products, Dealer Lens (with its billed ERP orders) and **Management** (team members + dealer tagging).
  * **Billing** asks for the name (*Who's batting?*): New order · My orders · My dealers; Backend also gets the **Backend** tab (Billing desk · Sales team · Dealer tagging · Billing sheet settings).
  * Every orders / dealers / scoreboard table has a **dealer filter** (searchable), a **Columns** picker, drag-to-resize column edges (double-click an edge to reset) and click-to-sort headers. Column choices, widths and sort are saved per user in the shared database (`ui_prefs` table).
  * **The Dugout** (sign-in tile) is the sales manager's view-only seat: Scoreboard (per-person placed / billed / pending / fill rate, podium), Team orders, Team dealers. Optional `DUGOUT_PIN` env var, like `BACKEND_PIN`.
  * Submitting an order shows a review (product × sizes × qty × value, totals). Once placed, only the backend team can edit or cancel it (enforced by the API). Backend cancellations need a reason, shown on the order.
  * Avatars: picked in Backend → Sales team / Management, or by the sales person by clicking their avatar in the top bar.
  * My orders, All orders and the Billing desk all have a period filter (desk defaults to YTD) and the same status chips: All · To bill · Partially billed · Closed · Cancelled. New order has **+ Add product** and an **International order** checkbox (per-order override).
  * My / All orders have a period filter (MTD · YTD from 1 April · Custom, by order date) and five tiles that reconcile: **Placed = Billed + Pending + Cancelled/closed**, plus fill rate by value (billed ÷ (placed − cancelled)). Billed is valued at the order price. Status filters: To bill · Partially billed · Closed (fully billed or short-closed) · Cancelled.
  * Dealers can be flagged **International** (no GSTIN; postal code, state/province, 2-letter country code that goes into the billing sheet) and can have **several shipping addresses** (optional shipping GSTIN). A new order for such a dealer asks which address to ship to.
  * Dealer tags are one shared setting: a dealer tagged in Billing shows tagged in Management automatically (also matched via the ERP customer on linked orders), and can be changed there.
  * Dealer details edited inside an order apply to that order's billing sheet only; permanent changes are made by the backend in **All dealers**.
  * Backend can cancel a partially billed order in full (ERP links are kept for reference).

All of this (team members, dealer tags, dealers, orders, links) is stored **centrally in Postgres**, the same for everyone on every device. The browser only remembers "who am I" and an unsent order draft.

## Files
```
index.html          the app (sales dashboard + billing tabs)
billing.js          billing module (order entry, desk, linking, dealers, settings)
api/data.py         sales data from ERPNext (unchanged logic)
api/billing.py      billing API + database (Postgres in production, SQLite locally)
dev_server.py       local preview server (python dev_server.py → http://localhost:8787)
vercel.json         function config
requirements.txt    pg8000 (pure-Python Postgres driver)
```

## Deploy
1. Push this folder to a GitHub repo → **vercel.com → Add New → Project → Import** (Framework preset: **Other**).
2. **Add the database:** Vercel project → **Storage → Create Database → Neon (Postgres)** → connect it to the project.
   This sets `DATABASE_URL` (or `POSTGRES_URL`) automatically. Tables are created on first use.
3. **Environment variables** (Settings → Environment Variables, Production):

| Variable | Value |
|---|---|
| `ERP_API_KEY` | ERP API key |
| `ERP_API_SECRET` | ERP API secret |
| `SITE_PASSWORD` | team password; optional, defaults to `Howzat?` (case, spaces and `?` ignored) |

4. Deploy. No PINs are used: anyone with the team password can pick Backend or The Dugout.
   Then open the site → password → **Backend** → **Billing** → **Backend** tab:
   * add the team members
   * tag the dealers
   * check **Billing sheet settings**: warehouse codes (only `GGNER` is known so far, so add the others), channel slug `txy`, transaction types, and order numbering (default `B2B-1001…`)

## Verify
* Top right shows **ERP last refreshed …** (first load after deploy pulls from ERP, ~5 s). `/api/billing?a=boot` without the password returns 401 (correct).
* As a team member: add a dealer → new order → submit. As Backend: Billing desk → Create billing sheet → the CSV opens with the same 25 columns as the ERP import sample.
* Upload to ERP, then **+ ERP ID** with the new front-end order ID → the order moves to Partially / Fully billed.

## Notes
* Price in the sheet (`gst_price`) is the price **including GST**, which matches how ERP reads it (e.g. 2150 → net 2047.62 at 5%).
* The sample import file had the billing-address columns shifted by one (name in the street column). Generated sheets fill street / city / PIN / country / state correctly.
* The order reference in the sheet (`order_ref`, e.g. `B2B-1001`) is the app's own number. The *front-end order ID* (e.g. `90378`) is what ERP assigns after upload, and is what you link back.

* Round 6: dealer PO field removed from New order (and from review, detail, tables, export). ERP refresh moved to one shared 2-hourly snapshot (`erp_cache` table, actions `sales` / `erp_refresh`); per-page "Refresh from ERP" buttons replaced by the top-right control.
