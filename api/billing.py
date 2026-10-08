"""
Vercel Python serverless function: /api/billing?a=<action>
Offline billing workflow for Ten x You — shared (server-side) storage for:
  team members, dealer master + tagging, orders entered by team members,
  billing-sheet generation (Saleor bulk order import format), and linking
  front-end (Saleor) order numbers back to ERP Sales Orders for
  Ordered / Billed / Pending reconciliation.

Storage:
  - Production: Postgres (Vercel Postgres / Neon) via DATABASE_URL or POSTGRES_URL.
  - Local dev:  SQLite file (local-billing.db) when no DATABASE_URL is set.

Env vars:
  ERP_API_KEY, ERP_API_SECRET   ERPNext token (read-only use)
  DATABASE_URL / POSTGRES_URL   Postgres connection string
  SITE_PASSWORD                 team password (default "Howzat?")
  BACKEND_PIN                   optional; if set, the Backend role must enter it
  DUGOUT_PIN                    optional; if set, The Dugout (sales manager) must enter it

ERP data (sales dashboard + billed quantities) is pulled at most every 2 hours and kept in the
shared database, so every user sees the same figures and the same "last refreshed" time.
"Refresh now" forces a fresh pull for everyone.
"""
from http.server import BaseHTTPRequestHandler
import csv, datetime, gzip, importlib.util, io, json, threading, os, re, ssl, time, urllib.parse, urllib.request

ERP_BASE = os.environ.get("ERP_URL", "https://erp.tenxyou.com").rstrip("/")
DB_URL = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL") or ""
LOCAL_DB = os.environ.get("LOCAL_DB") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "local-billing.db")
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
ERP_STALE_SECONDS = 2 * 3600  # ERP pull interval (sales snapshot + linked orders)

SHEET_HEADER = ["order_ref", "variant_id", "quantity", "gst_price", "gst_number", "transaction_type",
                "transaction_amount", "customer_number", "customer_name",
                "shipping_address_street", "shipping_address_city", "shipping_address_postal",
                "shipping_address_country", "shipping_address_country_area",
                "billing_address_street", "billing_address_city", "billing_address_postal",
                "billing_address_country", "billing_address_country_area",
                "channel_slug", "pg_payment_trnx_id", "payment_id", "payment_instrument", "warehouse", "po_ref"]

DEFAULT_SETTINGS = {
    "warehouses": [{"code": "GGNER", "label": "Gurgaon ER"}],
    "default_warehouse": "GGNER",
    "channel_slug": "txy",
    "transaction_types": ["Prepaid"],
    "default_txn": "Prepaid",
    "ref_prefix": "B2B-",
    "ref_start": 1001,
}

GST_STATES = {
    "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
    "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
    "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura",
    "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha",
    "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
    "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
    "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
    "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
}
GSTIN_RE = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
ORDER_NO_RE = re.compile(r"^\d{4,7}$")


class ApiError(Exception):
    def __init__(self, code, msg, **extra):
        super().__init__(msg)
        self.code, self.msg, self.extra = code, msg, extra


def now():
    return datetime.datetime.now(IST).isoformat(timespec="seconds")


def norm_key(s):
    return re.sub(r"[?\s]", "", (s or "").lower())


def norm_name(s):
    s = (s or "").lower()
    s = re.sub(r"[-\s]+(billing|shipping)?[-\s]*\d+$", "", s)
    return re.sub(r"[^a-z0-9]", "", s)


# ---------------------------------------------------------------- database
_PG = threading.local()  # one connection per worker thread, kept open while the function instance stays warm


def _pg_connect():
    import pg8000.dbapi
    u = urllib.parse.urlparse(DB_URL)
    return pg8000.dbapi.connect(
        user=urllib.parse.unquote(u.username or ""), password=urllib.parse.unquote(u.password or ""),
        host=u.hostname, port=u.port or 5432, database=(u.path or "/postgres").lstrip("/") or "postgres",
        ssl_context=ssl.create_default_context())


class DB:
    def __init__(self):
        self.pg = bool(DB_URL)
        self.used = False
        if self.pg:
            if getattr(_PG, "conn", None) is None:
                _PG.conn = _pg_connect()
            self.conn = _PG.conn
        else:
            if os.environ.get("VERCEL"):
                raise ApiError(503, "Database not connected — in Vercel open Storage → Create Database → Neon → Connect to project, then Redeploy")
            import sqlite3
            self.conn = sqlite3.connect(LOCAL_DB)

    def q(self, sql, params=()):
        if self.pg:
            sql = sql.replace("?", "%s")
            if not self.used:  # a kept-open connection may have been dropped (e.g. Neon idled) — reconnect once
                self.used = True
                try:
                    cur = self.conn.cursor()
                    cur.execute(sql, tuple(params))
                except Exception as e:
                    if type(e).__name__ not in ("InterfaceError", "OperationalError", "BrokenPipeError",
                                                "ConnectionResetError", "ConnectionAbortedError"):
                        raise
                    try:
                        self.conn.close()
                    except Exception:
                        pass
                    _PG.conn = self.conn = _pg_connect()
                    cur = self.conn.cursor()
                    cur.execute(sql, tuple(params))
                return self._rows(cur)
        cur = self.conn.cursor()
        cur.execute(sql, tuple(params))
        return self._rows(cur)

    def _rows(self, cur):
        rows = []
        if cur.description:
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        cur.close()
        return rows

    def one(self, sql, params=()):
        r = self.q(sql, params)
        return r[0] if r else None

    def commit(self):
        self.conn.commit()

    def rollback(self):
        try:
            self.conn.rollback()
        except Exception:
            pass

    def close(self):
        try:
            if self.pg:
                self.conn.rollback()  # leave the shared connection clean for the next request
            else:
                self.conn.close()
        except Exception:
            if self.pg:
                _PG.conn = None


def ph(n):
    return ",".join("?" * n)


_SCHEMA_OK = False


SCHEMA_V = "2026-10-08b"  # bump when ensure_schema gains a table / column


def ensure_schema(db):
    global _SCHEMA_OK
    if _SCHEMA_OK:
        return
    try:
        r = db.one("SELECT v FROM erp_cache WHERE k = '_schema'")
        if r and r["v"] == SCHEMA_V:
            _SCHEMA_OK = True
            return
    except Exception:
        db.rollback()  # brand-new database: create everything below
    ID = "SERIAL PRIMARY KEY" if db.pg else "INTEGER PRIMARY KEY AUTOINCREMENT"
    NUM = "DOUBLE PRECISION" if db.pg else "REAL"
    stmts = [
        f"CREATE TABLE IF NOT EXISTS team_members (id {ID}, name TEXT NOT NULL UNIQUE, colour TEXT, active INTEGER DEFAULT 1, created_at TEXT)",
        f"""CREATE TABLE IF NOT EXISTS dealers (id {ID}, name TEXT NOT NULL UNIQUE, team_id INTEGER, excluded INTEGER DEFAULT 0,
            gstin TEXT, phone TEXT, contact TEXT, email TEXT,
            bill_street TEXT, bill_city TEXT, bill_pin TEXT, bill_state TEXT,
            ship_same INTEGER DEFAULT 1, ship_street TEXT, ship_city TEXT, ship_pin TEXT, ship_state TEXT,
            notes TEXT, source TEXT, created_by TEXT, created_at TEXT, updated_at TEXT)""",
        f"""CREATE TABLE IF NOT EXISTS orders (id {ID}, ref TEXT UNIQUE, dealer_id INTEGER NOT NULL, team_id INTEGER,
            po_ref TEXT, remarks TEXT, status TEXT NOT NULL, created_by TEXT, created_at TEXT, submitted_at TEXT, updated_at TEXT,
            sheet_at TEXT, sheet_by TEXT, sheet_count INTEGER DEFAULT 0, warehouse TEXT,
            closed_at TEXT, closed_by TEXT, close_reason TEXT)""",
        f"CREATE TABLE IF NOT EXISTS order_lines (id {ID}, order_id INTEGER NOT NULL, sku TEXT NOT NULL, qty {NUM}, price {NUM})",
        f"""CREATE TABLE IF NOT EXISTS order_links (id {ID}, order_id INTEGER NOT NULL, saleor_no TEXT NOT NULL,
            note TEXT, flags TEXT, linked_by TEXT, linked_at TEXT, UNIQUE(order_id, saleor_no))""",
        f"""CREATE TABLE IF NOT EXISTS erp_lines (id {ID}, saleor_no TEXT NOT NULL, so_name TEXT, customer TEXT,
            so_status TEXT, so_date TEXT, sku TEXT, qty {NUM}, rate {NUM}, amount {NUM}, fetched_at TEXT)""",
        "CREATE TABLE IF NOT EXISTS erp_fetch (saleor_no TEXT PRIMARY KEY, found INTEGER, fetched_at TEXT)",
        f"CREATE TABLE IF NOT EXISTS events (id {ID}, order_id INTEGER, at TEXT, who TEXT, what TEXT)",
        "CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)",
        "CREATE TABLE IF NOT EXISTS ui_prefs (who TEXT PRIMARY KEY, v TEXT, updated_at TEXT)",
        "CREATE TABLE IF NOT EXISTS erp_cache (k TEXT PRIMARY KEY, v TEXT, fetched_at TEXT)",
        f"CREATE TABLE IF NOT EXISTS digest_recipients (id {ID}, email TEXT NOT NULL UNIQUE, name TEXT, added_by TEXT, added_at TEXT)",
        "CREATE INDEX IF NOT EXISTS ix_lines_order ON order_lines(order_id)",
        "CREATE INDEX IF NOT EXISTS ix_links_no ON order_links(saleor_no)",
        "CREATE INDEX IF NOT EXISTS ix_erp_no ON erp_lines(saleor_no)",
        "CREATE INDEX IF NOT EXISTS ix_events_order ON events(order_id)",
    ]
    for s in stmts:
        db.q(s)
    db.commit()
    # migrations (added columns)
    for table, col, typ in (("orders", "dealer_ov", "TEXT"), ("orders", "ship_sel", "TEXT"),
                            ("dealers", "is_intl", "INTEGER DEFAULT 0"), ("dealers", "country", "TEXT"),
                            ("dealers", "ship_addrs", "TEXT"), ("team_members", "avatar", "TEXT"),
                            ("orders", "cancel_reason", "TEXT"), ("orders", "cancelled_by", "TEXT"), ("orders", "cancelled_at", "TEXT"),
                            ("erp_lines", "erp_row", "TEXT")):
        if db.pg:
            db.q("ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s %s" % (table, col, typ))
        elif col not in {r["name"] for r in db.q("PRAGMA table_info(%s)" % table)}:
            db.q("ALTER TABLE %s ADD COLUMN %s %s" % (table, col, typ))
    db.q("INSERT INTO erp_cache (k, v, fetched_at) VALUES ('_schema', ?, ?) "
         "ON CONFLICT (k) DO UPDATE SET v = excluded.v, fetched_at = excluded.fetched_at", (SCHEMA_V, now()))
    db.commit()
    _SCHEMA_OK = True


def get_settings(db):
    s = dict(DEFAULT_SETTINGS)
    for r in db.q("SELECT k, v FROM settings"):
        try:
            s[r["k"]] = json.loads(r["v"])
        except Exception:
            pass
    return s


# ---------------------------------------------------------------- ERP
def _erp_headers():
    key, secret = os.environ.get("ERP_API_KEY", ""), os.environ.get("ERP_API_SECRET", "")
    if not key or not secret:
        raise ApiError(500, "ERP_API_KEY / ERP_API_SECRET environment variables are not set")
    return {"Authorization": "token %s:%s" % (key, secret)}


def erp_list(doctype, fields, filters, limit=0):
    params = urllib.parse.urlencode({"filters": json.dumps(filters), "fields": json.dumps(fields),
                                     "limit_page_length": limit})
    url = ERP_BASE + "/api/resource/" + urllib.parse.quote(doctype) + "?" + params
    req = urllib.request.Request(url, headers=_erp_headers())
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.load(resp).get("data", [])


_ITEMS = {"t": 0, "rows": None, "map": None}


_REQ = threading.local()  # the current request's database, for the item-master cache


def item_rows():
    if _ITEMS["rows"] is None or time.time() - _ITEMS["t"] > 6 * 3600:
        db, rows, t = getattr(_REQ, "db", None), None, time.time()
        if db is not None:
            r = db.one("SELECT v, fetched_at FROM erp_cache WHERE k = 'items'")
            if r and r["v"]:
                age = (datetime.datetime.now(IST) - datetime.datetime.fromisoformat(r["fetched_at"])).total_seconds()
                if age < 6 * 3600:
                    rows, t = json.loads(r["v"]), time.time() - age
        if rows is None:
            rows = erp_list("Item", ["item_code", "item_name", "custom_style_id", "custom_color", "custom_size",
                                     "item_group"], [["disabled", "=", 0]])
            if db is not None:
                db.q("INSERT INTO erp_cache (k, v, fetched_at) VALUES ('items', ?, ?) "
                     "ON CONFLICT (k) DO UPDATE SET v = excluded.v, fetched_at = excluded.fetched_at",
                     (json.dumps(rows, separators=(",", ":")), now()))
                db.commit()
        _ITEMS.update(t=t, rows=rows,
                      map={(r["item_code"] or "").strip().upper(): r["item_code"] for r in rows if r.get("item_code")})
    return _ITEMS["rows"]


def sku_map():
    item_rows()
    return _ITEMS["map"]


def erp_refresh(db, nos):
    """Pull the B2B Sales Orders for these front-end order numbers and snapshot their lines."""
    nos = sorted(set(nos))
    if db.pg:  # one refresh at a time: two overlapping pulls used to leave every ERP line in twice
        db.q("SELECT pg_advisory_xact_lock(8137201)")
    t = now()
    for i in range(0, len(nos), 100):
        chunk = nos[i:i + 100]
        rows = erp_list("Sales Order",
                        ["name", "customer", "status", "transaction_date", "custom_saleor_order_no",
                         "`tabSales Order Item`.item_code", "`tabSales Order Item`.qty",
                         "`tabSales Order Item`.rate", "`tabSales Order Item`.amount", "`tabSales Order Item`.name as erp_row"],
                        [["custom_is_b2b", "=", 1], ["custom_saleor_order_no", "in", chunk]])
        db.q(f"DELETE FROM erp_lines WHERE saleor_no IN ({ph(len(chunk))})", chunk)
        found = set()
        for r in rows:
            no = str(r.get("custom_saleor_order_no") or "").strip()
            if not no:
                continue
            found.add(no)
            db.q("INSERT INTO erp_lines (saleor_no, so_name, customer, so_status, so_date, sku, qty, rate, amount, fetched_at, erp_row) "
                 "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                 (no, r.get("name"), r.get("customer"), r.get("status"), str(r.get("transaction_date") or ""),
                  r.get("item_code"), float(r.get("qty") or 0), float(r.get("rate") or 0),
                  float(r.get("amount") or 0), t, r.get("erp_row")))
        for no in chunk:
            db.q("INSERT INTO erp_fetch (saleor_no, found, fetched_at) VALUES (?,?,?) "
                 "ON CONFLICT (saleor_no) DO UPDATE SET found = excluded.found, fetched_at = excluded.fetched_at",
                 (no, 1 if no in found else 0, t))


def erp_snapshot(db, nos):
    """{no: {found, fetched_at, sos: {so_name: {customer,status,date,lines:[...]}}}}"""
    out = {}
    if not nos:
        return out
    nos = list(nos)
    for r in db.q(f"SELECT * FROM erp_fetch WHERE saleor_no IN ({ph(len(nos))})", nos):
        out[r["saleor_no"]] = {"found": bool(r["found"]), "fetched_at": r["fetched_at"], "sos": {}}
    seen = set()
    for r in db.q(f"SELECT * FROM erp_lines WHERE saleor_no IN ({ph(len(nos))}) ORDER BY id", nos):
        if r.get("erp_row"):
            if (r["so_name"], r["erp_row"]) in seen:
                continue
            seen.add((r["so_name"], r["erp_row"]))
        e = out.setdefault(r["saleor_no"], {"found": True, "fetched_at": r["fetched_at"], "sos": {}})
        so = e["sos"].setdefault(r["so_name"], {"so": r["so_name"], "customer": r["customer"], "status": r["so_status"],
                                                "date": r["so_date"], "lines": []})
        so["lines"].append({"sku": r["sku"], "qty": r["qty"] or 0, "rate": r["rate"] or 0, "amount": r["amount"] or 0})
    return out


def summarize_no(e):
    """Flatten one front-end order number's ERP snapshot to a display summary."""
    if not e or not e["found"]:
        return {"found": False}
    sos = list(e["sos"].values())
    live = [s for s in sos if s["status"] != "Cancelled"]
    use = live or sos
    return {"found": True, "cancelled": not live, "so": ", ".join(s["so"] for s in use),
            "customer": use[0]["customer"] if use else "", "status": ", ".join(sorted({s["status"] for s in use})),
            "date": min((s["date"] for s in use), default=""),
            "qty": sum(l["qty"] for s in live for l in s["lines"]),
            "amount": sum(l["amount"] for s in live for l in s["lines"]),
            "skus": sorted({l["sku"] for s in live for l in s["lines"]}), "fetched_at": e.get("fetched_at")}


# ---------------------------------------------------------------- context / helpers
class Ctx:
    def __init__(self, db, who):
        self.db = db
        self.who = who or ""
        self.is_backend = self.who == "backend"
        self.is_dash = self.who == "dash"
        self.is_mgr = self.who == "dugout"
        self.team_id = None
        self.name = "Dashboard" if self.is_dash else "The Dugout" if self.is_mgr else "Backend"
        if self.who.startswith("tm:"):
            try:
                self.team_id = int(self.who[3:])
            except ValueError:
                raise ApiError(401, "Unknown user — pick your name again")
            t = db.one("SELECT * FROM team_members WHERE id = ? AND active = 1", (self.team_id,))
            if not t:
                raise ApiError(401, "Unknown user — pick your name again")
            self.name = t["name"]
        elif not self.is_backend and not self.is_dash and not self.is_mgr:
            raise ApiError(401, "Pick your name first")

    def need_backend(self):
        if not self.is_backend:
            raise ApiError(403, "Only the backend billing team can do this")

    def need_manage(self):  # team + dealer tagging: backend (Billing) or the dashboard's Management tab
        if not (self.is_backend or self.is_dash):
            raise ApiError(403, "Only the backend team can do this")

    def log(self, order_id, what):
        self.db.q("INSERT INTO events (order_id, at, who, what) VALUES (?,?,?,?)", (order_id, now(), self.name, what))


def dealer_complete(d):
    return bool(d and d.get("phone") and d.get("bill_street") and d.get("bill_city") and d.get("bill_pin")
                and d.get("bill_state") and (d.get("ship_same") or (d.get("ship_street") and d.get("ship_city")
                                                                     and d.get("ship_pin") and d.get("ship_state"))))


def ship_list(d):
    """A dealer's shipping addresses (empty list = ships to the billing address)."""
    try:
        lst = json.loads(d.get("ship_addrs") or "null")
    except Exception:
        lst = None
    if lst is None:  # dealers saved before multiple addresses existed
        lst = [] if d.get("ship_same", 1) else [{"label": "", "street": d.get("ship_street") or "", "city": d.get("ship_city") or "",
                                                  "pin": d.get("ship_pin") or "", "state": d.get("ship_state") or "",
                                                  "country": d.get("country") or "IN", "gstin": ""}]
    return lst


def dealer_out(d):
    o = {k: d[k] for k in ("id", "name", "team_id", "gstin", "phone", "contact", "email", "bill_street", "bill_city",
                           "bill_pin", "bill_state", "ship_street", "ship_city", "ship_pin", "ship_state", "notes",
                           "source", "created_by", "created_at")}
    o["excluded"] = bool(d["excluded"])
    o["ship_same"] = bool(d["ship_same"])
    o["is_intl"] = bool(d.get("is_intl"))
    o["country"] = d.get("country") or ("" if d.get("is_intl") else "IN")
    o["ship_addrs"] = ship_list(d)
    o["complete"] = dealer_complete(d)
    return o


def load_order(db, oid):
    o = db.one("SELECT * FROM orders WHERE id = ?", (oid,))
    if not o:
        raise ApiError(404, "Order not found")
    return o


def can_see_dealer(ctx, dealer):
    return ctx.is_backend or (dealer and dealer["team_id"] == ctx.team_id)


# ---------------------------------------------------------------- reconciliation
OV_FIELDS = ("name", "gstin", "phone", "contact", "email", "bill_street", "bill_city", "bill_pin", "bill_state",
             "ship_same", "ship_street", "ship_city", "ship_pin", "ship_state",
             "is_intl", "country", "ship_gstin", "ship_label", "ship_country")


def order_dealer(o, d):
    """Dealer details as used for this order: master record, overridden by edits made for this order only."""
    if not d:
        return d
    m = dict(d)
    m["country"] = m.get("country") or ("" if m.get("is_intl") else "IN")
    first = (ship_list(d) or [None])[0]
    m["ship_gstin"], m["ship_label"] = (first or {}).get("gstin", ""), (first or {}).get("label", "")
    m["ship_country"] = (first or {}).get("country") or m["country"]
    # shipping address picked on the order (snapshot)
    try:
        sel = json.loads(o.get("ship_sel") or "null")
    except Exception:
        sel = None
    if sel:
        if sel.get("idx", -1) < 0:
            m.update(ship_same=1, ship_street=m["bill_street"], ship_city=m["bill_city"], ship_pin=m["bill_pin"],
                     ship_state=m["bill_state"], ship_gstin="", ship_label="Billing address", ship_country=m["country"])
        else:
            m.update(ship_same=0, ship_street=sel.get("street", ""), ship_city=sel.get("city", ""), ship_pin=sel.get("pin", ""),
                     ship_state=sel.get("state", ""), ship_gstin=sel.get("gstin", ""), ship_label=sel.get("label", ""),
                     ship_country=sel.get("country") or m["country"])
    try:
        ov = json.loads(o.get("dealer_ov") or "null")
    except Exception:
        ov = None
    if ov:
        for k in OV_FIELDS:
            if k in ov:
                m[k] = ov[k]
    return m


def build_orders(db):
    """All orders with lines, links, ERP allocation and derived stage."""
    orders = db.q("SELECT * FROM orders ORDER BY id DESC")
    lines = db.q("SELECT * FROM order_lines ORDER BY id")
    links = db.q("SELECT * FROM order_links ORDER BY id")
    dealers = {d["id"]: d for d in db.q("SELECT * FROM dealers")}
    team = {t["id"]: t for t in db.q("SELECT * FROM team_members")}
    by_o = {o["id"]: o for o in orders}
    olines = {}
    for l in lines:
        olines.setdefault(l["order_id"], []).append(l)
    olinks = {}
    no_orders = {}
    for k in links:
        olinks.setdefault(k["order_id"], []).append(k)
        if k["order_id"] in by_o:
            no_orders.setdefault(k["saleor_no"], []).append(k["order_id"])
    snap = erp_snapshot(db, list(no_orders))

    remaining = {o["id"]: {} for o in orders}
    for oid, ls in olines.items():
        for l in ls:
            remaining.setdefault(oid, {})
            remaining[oid][l["sku"]] = remaining[oid].get(l["sku"], 0) + (l["qty"] or 0)
    billed = {o["id"]: {} for o in orders}
    extras = {o["id"]: [] for o in orders}
    oprice = {}  # order price per SKU, to value billed units the same way everywhere
    for oid, ls in olines.items():
        for l in ls:
            oprice.setdefault((oid, l["sku"]), l["price"] or 0)
    by_day = {o["id"]: {} for o in orders}  # ERP Sales Order date -> [units, value] billed for this order

    def add_day(oid, day, q, v):
        x = by_day[oid].setdefault((day or "")[:10], [0, 0])
        x[0] += q
        x[1] += v

    def no_date(n):
        s = summarize_no(snap.get(n))
        return (s.get("date") or "9999", n)

    for no in sorted(no_orders, key=no_date):
        e = snap.get(no)
        if not e or not e["found"]:
            continue
        oids = sorted(set(no_orders[no]), key=lambda i: by_o[i]["created_at"] or "")
        for so in e["sos"].values():
            if so["status"] == "Cancelled":
                continue
            for ln in so["lines"]:
                q, sku = ln["qty"], ln["sku"]
                rate = ln["rate"] or (ln["amount"] / ln["qty"] if ln["qty"] else 0)
                for oid in oids:
                    take = min(q, remaining[oid].get(sku, 0))
                    if take > 0:
                        remaining[oid][sku] -= take
                        b = billed[oid].setdefault(sku, [0, 0])
                        b[0] += take
                        b[1] += take * rate
                        add_day(oid, so["date"], take, take * oprice.get((oid, sku), 0))
                        q -= take
                    if q <= 0:
                        break
                if q > 0:
                    extras[oids[0]].append({"sku": sku, "qty": q, "rate": rate, "no": no, "so": so["so"]})
                    add_day(oids[0], so["date"], q, q * rate)

    out = []
    for o in orders:
        oid = o["id"]
        d0 = dealers.get(o["dealer_id"])
        d = order_dealer(o, d0)
        closed = bool(o["closed_at"]) or o["status"] == "cancelled"
        L = []
        for l in olines.get(oid, []):
            b = billed[oid].get(l["sku"], [0, 0])
            L.append({"sku": l["sku"], "qty": l["qty"], "price": l["price"], "billed": 0, "billed_amt": 0})
        # spread billed qty over duplicate-SKU lines (normally one line per SKU)
        for l in L:
            b = billed[oid].get(l["sku"])
            if b and b[0] > 0:
                take = min(b[0], l["qty"])
                frac = take / b[0] if b[0] else 0
                l["billed"], l["billed_amt"] = take, b[1] * frac
                b[0] -= take
                b[1] -= l["billed_amt"]
            l["pending"] = 0 if closed else max(0, (l["qty"] or 0) - l["billed"])
            l["short_closed"] = max(0, (l["qty"] or 0) - l["billed"]) if closed else 0
        oq = sum(l["qty"] or 0 for l in L)
        ov = sum((l["qty"] or 0) * (l["price"] or 0) for l in L)
        bq = sum(l["billed"] for l in L)
        bv = sum(l["billed_amt"] for l in L)
        pq = sum(l["pending"] for l in L)
        pv = sum(l["pending"] * (l["price"] or 0) for l in L)
        cq = sum(l["short_closed"] for l in L)
        cv = sum(l["short_closed"] * (l["price"] or 0) for l in L)
        bvo = sum(l["billed"] * (l["price"] or 0) for l in L)  # billed qty valued at the order price
        lk = []
        for k in olinks.get(oid, []):
            s = summarize_no(snap.get(k["saleor_no"]))
            s.update({"no": k["saleor_no"], "linked_by": k["linked_by"], "linked_at": k["linked_at"],
                      "note": k["note"], "flags": json.loads(k["flags"] or "[]"),
                      "shared_with": [by_o[x]["ref"] for x in no_orders.get(k["saleor_no"], []) if x != oid]})
            lk.append(s)
        st = o["status"]
        if st in ("draft", "cancelled"):
            stage = st
        elif closed:
            stage = "closed"
        elif bq > 0 and pq == 0:
            stage = "billed"
        elif bq > 0:
            stage = "partial"
        elif lk:
            stage = "linked"
        elif o["sheet_at"]:
            stage = "sheet"
        else:
            stage = "tobill"
        tm = team.get(d["team_id"]) if d else None
        out.append({
            "id": oid, "ref": o["ref"], "status": st, "stage": stage, "dealer_id": o["dealer_id"],
            "dealer": d0["name"] if d0 else "(deleted dealer)", "dealer_complete": dealer_complete(d),
            "dealer_ov": json.loads(o["dealer_ov"]) if o.get("dealer_ov") else None,
            "ship_sel": json.loads(o["ship_sel"]) if o.get("ship_sel") else None,
            "ship_to": {"label": (d or {}).get("ship_label") or "", "gstin": (d or {}).get("ship_gstin") or "",
                        "text": ", ".join(x for x in [(d or {}).get("ship_street"), (d or {}).get("ship_city"),
                                                      " ".join(x for x in [(d or {}).get("ship_state"), (d or {}).get("ship_pin")] if x),
                                                      (d or {}).get("ship_country") if (d or {}).get("ship_country") not in (None, "", "IN") else ""] if x)},
            "team_id": d["team_id"] if d else None, "team": tm["name"] if tm else None,
            "po_ref": o["po_ref"], "remarks": o["remarks"], "created_by": o["created_by"],
            "created_at": o["created_at"], "submitted_at": o["submitted_at"], "updated_at": o["updated_at"],
            "sheet_at": o["sheet_at"], "sheet_by": o["sheet_by"], "sheet_count": o["sheet_count"] or 0,
            "warehouse": o["warehouse"], "closed_at": o["closed_at"], "closed_by": o["closed_by"],
            "close_reason": o["close_reason"],
            "cancel_reason": o.get("cancel_reason"), "cancelled_by": o.get("cancelled_by"), "cancelled_at": o.get("cancelled_at"),
            "lines": L, "extras": extras[oid], "links": lk, "billed_by_day": by_day[oid],
            "tot": {"oq": oq, "ov": ov, "bq": bq, "bv": bv, "pq": pq, "pv": pv, "cq": cq, "cv": cv, "bvo": bvo,
                    "eq": sum(x["qty"] for x in extras[oid]), "ev": sum(x["qty"] * (x["rate"] or 0) for x in extras[oid])},
        })
    return out


# ---------------------------------------------------------------- actions
def a_boot(ctx, qs, body):
    db = ctx.db
    return {"team": [{"id": t["id"], "name": t["name"], "colour": t["colour"], "avatar": t.get("avatar"), "active": bool(t["active"])}
                     for t in db.q("SELECT * FROM team_members ORDER BY name")],
            "dealers": [dealer_out(d) for d in db.q("SELECT * FROM dealers ORDER BY name")],
            "erp_alias": [[r["customer"], r["dealer_id"]] for r in db.q(
                "SELECT DISTINCT e.customer, o.dealer_id FROM erp_lines e JOIN order_links k ON k.saleor_no = e.saleor_no "
                "JOIN orders o ON o.id = k.order_id WHERE e.customer IS NOT NULL AND o.status <> 'cancelled'")],
            "settings": get_settings(db), "states": GST_STATES,
            "pin_required": bool(os.environ.get("BACKEND_PIN")), "dugout_pin_required": bool(os.environ.get("DUGOUT_PIN"))}


_SALES = {}


def _sales_build():  # the sales-dashboard pull lives in api/data.py
    if "m" not in _SALES:
        spec = importlib.util.spec_from_file_location("salesdata", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.py"))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        _SALES["m"] = m
    return _SALES["m"].build()


def sales_snapshot(db, force=False):
    r = db.one("SELECT v, fetched_at FROM erp_cache WHERE k = 'sales'")
    cutoff = (datetime.datetime.now(IST) - datetime.timedelta(seconds=ERP_STALE_SECONDS)).isoformat(timespec="seconds")
    if r and r["v"] and not force:
        d = json.loads(r["v"])
        d["stale"] = (r["fetched_at"] or "") < cutoff  # the page then asks for a refresh in the background
        return d, None
    try:
        d = _sales_build()
        d["generatedAt"] = now()
        v = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
        db.q("INSERT INTO erp_cache (k, v, fetched_at) VALUES ('sales', ?, ?) "
             "ON CONFLICT (k) DO UPDATE SET v = excluded.v, fetched_at = excluded.fetched_at", (v, d["generatedAt"]))
        db.commit()
        return d, None
    except Exception as e:  # keep serving the last snapshot
        db.rollback()
        if r and r["v"]:
            return json.loads(r["v"]), "Could not reach ERP just now — showing the last refreshed figures (%s)" % e
        raise ApiError(502, "Could not reach ERP: %s" % e)


def a_sales(ctx, qs, body):
    d, warn = sales_snapshot(ctx.db)
    d["warning"] = warn
    return d


def a_erp_refresh(ctx, qs, body):  # "Refresh now" or the page's background refresh: pull everything for everyone
    db = ctx.db
    if body.get("auto"):  # background: skip if someone refreshed in the last few minutes or a refresh is running
        r = db.one("SELECT fetched_at FROM erp_cache WHERE k = 'sales'")
        recent = (datetime.datetime.now(IST) - datetime.timedelta(minutes=5)).isoformat(timespec="seconds")
        if r and (r["fetched_at"] or "") >= recent:
            return {"ok": True, "at": r["fetched_at"], "skipped": True}
        if db.pg and not db.one("SELECT pg_try_advisory_xact_lock(8137202) AS ok")["ok"]:
            return {"ok": True, "busy": True}
    d, warn = sales_snapshot(db, force=True)
    if warn:
        raise ApiError(502, warn)
    nos = [r["saleor_no"] for r in db.q("SELECT DISTINCT saleor_no FROM order_links")]
    if nos:
        try:
            erp_refresh(db, nos)
            db.commit()
        except Exception as e:
            db.rollback()
            raise ApiError(502, "Sales figures refreshed, but linked orders could not be pulled: %s" % e)
    _ITEMS["t"] = 0  # product catalogue reloads on next use
    db.q("DELETE FROM erp_cache WHERE k = 'items'")
    db.commit()
    return {"ok": True, "at": d["generatedAt"]}


def a_items(ctx, qs, body):
    rows = item_rows()
    return {"items": [[r["item_code"], r.get("item_name") or "", r.get("custom_style_id") or "",
                       r.get("custom_color") or "", str(r.get("custom_size") or "").strip(), r.get("item_group") or ""]
                      for r in rows if r.get("item_code")]}


def a_orders(ctx, qs, body):
    db = ctx.db
    warn = None
    nos = [r["saleor_no"] for r in db.q("SELECT DISTINCT saleor_no FROM order_links")]
    if nos:
        fetched = {r["saleor_no"]: r["fetched_at"] for r in db.q("SELECT * FROM erp_fetch")}
        cutoff = (datetime.datetime.now(IST) - datetime.timedelta(seconds=ERP_STALE_SECONDS)).isoformat(timespec="seconds")
        old = {r["saleor_no"] for r in db.q("SELECT DISTINCT saleor_no FROM erp_lines WHERE erp_row IS NULL")}
        # stale links are pulled by the page's background refresh; only never-pulled ones (or ?sync=1) are fetched here
        stale = [n for n in nos if not fetched.get(n) or n in old or qs.get("sync") == "1"]
        if stale:
            try:
                erp_refresh(db, stale)
                db.commit()
            except Exception as e:  # keep serving the last snapshot
                db.rollback()
                warn = "Could not reach ERP just now — showing the last synced figures (%s)" % e
    orders = build_orders(db)
    if not ctx.is_backend and not ctx.is_dash and not ctx.is_mgr:
        mine = {d["id"] for d in db.q("SELECT id FROM dealers WHERE team_id = ?", (ctx.team_id,))}
        orders = [o for o in orders if o["dealer_id"] in mine]
    events = {}
    ids = [o["id"] for o in orders]
    if ids:
        for e in db.q(f"SELECT * FROM events WHERE order_id IN ({ph(len(ids))}) ORDER BY id", ids):
            events.setdefault(e["order_id"], []).append({"at": e["at"], "who": e["who"], "what": e["what"]})
    for o in orders:
        o["events"] = events.get(o["id"], [])
    last = db.one("SELECT MAX(fetched_at) AS m FROM erp_fetch")
    return {"orders": orders, "warning": warn, "erp_synced_at": last["m"] if last else None}


def _clean_addr(a, intl, states, pfx, errs):
    out = {k: str(a.get(k) or "").strip() for k in ("label", "street", "city", "pin", "state", "country", "gstin")}
    out["gstin"] = out["gstin"].upper().replace(" ", "")
    if not out["street"]:
        errs[pfx + "street"] = "Address is required"
    if not out["city"]:
        errs[pfx + "city"] = "City is required"
    if intl:
        out["country"], out["gstin"] = out["country"].upper(), ""
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 \-]{1,11}", out["pin"]):
            errs[pfx + "pin"] = "Postal / ZIP code"
        if not out["state"]:
            errs[pfx + "state"] = "State / province is required"
        if not COUNTRY_RE.match(out["country"]) or out["country"] == "IN":
            errs[pfx + "country"] = "2-letter country code, e.g. US, GB, AE"
    else:
        out["country"] = "IN"
        if not re.fullmatch(r"[1-9]\d{5}", out["pin"]):
            errs[pfx + "pin"] = "6-digit PIN code"
        if out["state"] not in states.values():
            errs[pfx + "state"] = "Pick a state"
        if out["gstin"]:
            if not GSTIN_RE.match(out["gstin"]):
                errs[pfx + "gstin"] = "GSTIN should be 15 characters"
            elif pfx + "state" not in errs and states.get(out["gstin"][:2]) != out["state"]:
                errs[pfx + "gstin"] = "This GSTIN is registered in %s" % states.get(out["gstin"][:2], "another state")
    return out


def _clean_dealer(b, states):
    def s(k):
        return (str(b.get(k) or "")).strip()
    intl = bool(b.get("is_intl"))
    d = {k: s(k) for k in ("name", "gstin", "phone", "contact", "email", "notes")}
    d["is_intl"] = 1 if intl else 0
    d["name"] = re.sub(r"\s+", " ", d["name"])
    d["gstin"] = "" if intl else d["gstin"].upper().replace(" ", "")
    errs = {}
    if not d["name"]:
        errs["name"] = "Dealer name is required"
    if d["gstin"] and not GSTIN_RE.match(d["gstin"]):
        errs["gstin"] = "GSTIN should be 15 characters, e.g. 27ABCDE1234F1Z5"
    if intl:
        d["phone"] = ("+" if d["phone"].startswith("+") else "") + re.sub(r"\D", "", d["phone"])
        if not 6 <= len(d["phone"].lstrip("+")) <= 15:
            errs["phone"] = "Phone number with country code"
    else:
        d["phone"] = re.sub(r"\D", "", d["phone"])
        if len(d["phone"]) == 12 and d["phone"].startswith("91"):
            d["phone"] = d["phone"][2:]
        if not re.fullmatch(r"[6-9]\d{9}", d["phone"] or ""):
            errs["phone"] = "Enter a 10-digit mobile number"
    if d["email"] and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", d["email"]):
        errs["email"] = "Email looks wrong"
    bill = _clean_addr({"street": s("bill_street"), "city": s("bill_city"), "pin": s("bill_pin"), "state": s("bill_state"),
                        "country": s("country")}, intl, states, "bill_", errs)
    for f in ("street", "city", "pin", "state"):
        d["bill_" + f] = bill[f]
    d["country"] = bill["country"]
    if d["gstin"] and not errs.get("gstin") and not errs.get("bill_state"):
        st = states.get(d["gstin"][:2])
        if st and st != d["bill_state"]:
            errs["bill_state"] = "GSTIN is registered in %s — billing state should match" % st
    if "ship_addrs" in b:  # dealer master: any number of shipping addresses
        addrs = [_clean_addr(a or {}, intl, states, "ship_%d_" % i, errs) for i, a in enumerate(b.get("ship_addrs") or [])]
    elif not b.get("ship_same", True):  # one shipping address (edits for a single order)
        addrs = [_clean_addr({"label": s("ship_label"), "street": s("ship_street"), "city": s("ship_city"), "pin": s("ship_pin"),
                              "state": s("ship_state"), "country": s("ship_country") or s("country"), "gstin": s("ship_gstin")},
                             intl, states, "ship_", errs)]
    else:
        addrs = []
    d["ship_addrs"] = addrs
    d["ship_same"] = 0 if addrs else 1
    first = addrs[0] if addrs else dict(street=d["bill_street"], city=d["bill_city"], pin=d["bill_pin"], state=d["bill_state"],
                                        country=d["country"], gstin="", label="")
    for f in ("street", "city", "pin", "state"):
        d["ship_" + f] = first[f]
    d["ship_gstin"], d["ship_label"], d["ship_country"] = first["gstin"], first["label"], first["country"]
    return d, errs


def a_dealer_check(ctx, qs, body):
    d, errs = _clean_dealer(body, GST_STATES)
    if errs:
        raise ApiError(400, "Please fix the highlighted fields", fields=errs)
    d["ship_same"] = bool(d["ship_same"])
    d["is_intl"] = bool(d["is_intl"])
    d.pop("notes", None)
    return {"dealer": d}


def a_dealer_save(ctx, qs, body):
    db = ctx.db
    did = body.get("id")
    cur = db.one("SELECT * FROM dealers WHERE id = ?", (did,)) if did else None
    if did and not cur:
        raise ApiError(404, "Dealer not found")
    if cur and not can_see_dealer(ctx, cur):
        raise ApiError(403, "This dealer is tagged to another team member")
    if cur and not ctx.is_backend:
        raise ApiError(403, "Dealer details are changed permanently by the backend team (All dealers). "
                            "For a single order, use Edit details on the order.")
    d, errs = _clean_dealer(body, GST_STATES)
    if errs:
        raise ApiError(400, "Please fix the highlighted fields", fields=errs)
    if cur and d["name"] != cur["name"] and not ctx.is_backend:
        raise ApiError(403, "Only the backend team can rename a dealer (the name must match the ERP customer)")
    others = [x for x in db.q("SELECT * FROM dealers") if not cur or x["id"] != cur["id"]]
    same_name = [x for x in others if norm_name(x["name"]) == norm_name(d["name"])]
    if same_name:
        x = same_name[0]
        raise ApiError(409, "A dealer with this name already exists", duplicates=[dealer_out(x)], hard=True)
    if not body.get("force"):
        dups = [x for x in others if (d["gstin"] and x["gstin"] == d["gstin"]) or (d["phone"] and x["phone"] == d["phone"])]
        if dups:
            raise ApiError(409, "Possible duplicate dealer — same GSTIN or mobile number", duplicates=[dealer_out(x) for x in dups])
    t = now()
    if ctx.is_backend:
        team_id = body.get("team_id") if "team_id" in body else (cur["team_id"] if cur else None)
    else:
        team_id = ctx.team_id
    d["ship_addrs"] = json.dumps(d["ship_addrs"])
    cols = ["name", "gstin", "phone", "contact", "email", "bill_street", "bill_city", "bill_pin", "bill_state",
            "ship_same", "ship_street", "ship_city", "ship_pin", "ship_state", "notes", "is_intl", "country", "ship_addrs"]
    if cur:
        db.q("UPDATE dealers SET " + ", ".join(c + " = ?" for c in cols) + ", team_id = ?, updated_at = ? WHERE id = ?",
             [d[c] for c in cols] + [team_id, t, cur["id"]])
        did = cur["id"]
    else:
        r = db.one("INSERT INTO dealers (" + ", ".join(cols) + ", team_id, excluded, source, created_by, created_at, updated_at) "
                   "VALUES (" + ph(len(cols) + 6) + ") RETURNING id",
                   [d[c] for c in cols] + [team_id, 0, "app", ctx.name, t, t])
        did = r["id"]
    return {"dealer": dealer_out(db.one("SELECT * FROM dealers WHERE id = ?", (did,)))}


def a_dealer_tag(ctx, qs, body):
    """Management tagging — by dealer name (ERP customer name). Creates a bare dealer row if needed."""
    ctx.need_manage()
    db = ctx.db
    names = body.get("names") or [body.get("name")]
    names = [n.strip() for n in names if n and str(n).strip()]
    if not names:
        raise ApiError(400, "Dealer name missing")
    team_id = body.get("team_id") or None
    exc = 1 if body.get("excluded") else 0
    t = now()
    for name in names:
        cur = db.one("SELECT * FROM dealers WHERE name = ?", (name,))
        if cur:
            db.q("UPDATE dealers SET team_id = ?, excluded = ?, updated_at = ? WHERE id = ?", (team_id, exc, t, cur["id"]))
        else:
            db.q("INSERT INTO dealers (name, team_id, excluded, ship_same, source, created_by, created_at, updated_at) "
                 "VALUES (?,?,?,?,?,?,?,?)", (name, team_id, exc, 1, "erp", ctx.name, t, t))
    return {"ok": True, "count": len(names)}


def a_team_save(ctx, qs, body):
    ctx.need_manage()
    db = ctx.db
    tid = body.get("id")
    name = re.sub(r"\s+", " ", (body.get("name") or "")).strip()
    colour = body.get("colour")
    avatar = body.get("avatar")
    if tid:
        cur = db.one("SELECT * FROM team_members WHERE id = ?", (tid,))
        if not cur:
            raise ApiError(404, "Team member not found")
        if name and name != cur["name"]:
            if db.one("SELECT id FROM team_members WHERE name = ? AND id <> ?", (name, tid)):
                raise ApiError(409, "Another team member already has that name")
            db.q("UPDATE team_members SET name = ? WHERE id = ?", (name, tid))
        if colour:
            db.q("UPDATE team_members SET colour = ? WHERE id = ?", (colour, tid))
        if avatar is not None:
            db.q("UPDATE team_members SET avatar = ? WHERE id = ?", (avatar or None, tid))
        return {"ok": True}
    if not name:
        raise ApiError(400, "Name is required")
    cur = db.one("SELECT * FROM team_members WHERE name = ?", (name,))
    if cur and cur["active"]:
        raise ApiError(409, "That team member already exists")
    if cur:
        db.q("UPDATE team_members SET active = 1, colour = COALESCE(?, colour) WHERE id = ?", (colour, cur["id"]))
    else:
        db.q("INSERT INTO team_members (name, colour, active, created_at) VALUES (?,?,1,?)", (name, colour, now()))
    return {"ok": True}


def a_my_avatar(ctx, qs, body):  # a sales person picks their own avatar
    if not ctx.team_id:
        raise ApiError(403, "Pick your name first")
    ctx.db.q("UPDATE team_members SET avatar = ? WHERE id = ?", ((body.get("avatar") or None), ctx.team_id))
    return {"ok": True}


def a_prefs(ctx, qs, body):  # table columns / widths / sort, per user, in the shared database
    who = ctx.who
    if body:
        v = json.dumps(body.get("prefs") or {})[:20000]
        ctx.db.q("INSERT INTO ui_prefs (who, v, updated_at) VALUES (?,?,?) ON CONFLICT (who) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at",
                 (who, v, now()))
        return {"ok": True}
    r = ctx.db.one("SELECT v FROM ui_prefs WHERE who = ?", (who,))
    return {"prefs": json.loads(r["v"]) if r and r["v"] else {}}


def a_team_delete(ctx, qs, body):
    ctx.need_manage()
    tid = body.get("id")
    ctx.db.q("UPDATE team_members SET active = 0 WHERE id = ?", (tid,))
    ctx.db.q("UPDATE dealers SET team_id = NULL WHERE team_id = ?", (tid,))
    return {"ok": True}


def a_settings_save(ctx, qs, body):
    ctx.need_backend()
    db = ctx.db
    s = get_settings(db)
    wh = [{"code": str(w.get("code") or "").strip(), "label": str(w.get("label") or "").strip()}
          for w in body.get("warehouses", s["warehouses"]) if str(w.get("code") or "").strip()]
    if not wh:
        raise ApiError(400, "Keep at least one warehouse")
    tx = [x.strip() for x in body.get("transaction_types", s["transaction_types"]) if str(x).strip()] or ["Prepaid"]
    new = {
        "warehouses": wh,
        "default_warehouse": body.get("default_warehouse") if body.get("default_warehouse") in [w["code"] for w in wh] else wh[0]["code"],
        "channel_slug": (body.get("channel_slug") or s["channel_slug"]).strip(),
        "transaction_types": tx,
        "default_txn": body.get("default_txn") if body.get("default_txn") in tx else tx[0],
        "ref_prefix": (body.get("ref_prefix") if body.get("ref_prefix") is not None else s["ref_prefix"]).strip(),
        "ref_start": int(body.get("ref_start") or s["ref_start"]),
    }
    for k, v in new.items():
        db.q("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", (k, json.dumps(v)))
    return {"settings": new}


def a_order_save(ctx, qs, body):
    db = ctx.db
    submit = body.get("action") == "submit"
    oid = body.get("id")
    cur = load_order(db, oid) if oid else None
    if cur:
        if cur["status"] not in ("draft", "submitted"):
            raise ApiError(409, "A cancelled order can't be edited")
        if cur["status"] == "submitted" and not ctx.is_backend:
            raise ApiError(403, "Once placed, an order can only be changed by the backend team")
        if cur["sheet_at"] and not ctx.is_backend:
            raise ApiError(409, "This order is already with billing and can't be edited")
        old_lines = db.q("SELECT qty, price FROM order_lines WHERE order_id = ?", (cur["id"],))
    dealer = db.one("SELECT * FROM dealers WHERE id = ?", (body.get("dealer_id"),))
    if not dealer:
        raise ApiError(400, "Pick a dealer")
    if not can_see_dealer(ctx, dealer):
        raise ApiError(403, "This dealer is tagged to another team member")
    if dealer["excluded"]:
        raise ApiError(400, "This dealer is marked as Excluded in Management")
    smap = sku_map()
    merged, unknown, problems = {}, [], []
    for i, l in enumerate(body.get("lines") or []):
        raw = str(l.get("sku") or "").strip().upper()
        if not raw:
            continue
        try:
            qty = float(l.get("qty") or 0)
            price = float(l.get("price") or 0)
        except (TypeError, ValueError):
            problems.append("%s: quantity / price must be numbers" % raw)
            continue
        if qty <= 0:
            continue
        if qty != int(qty):
            problems.append("%s: quantity must be a whole number" % raw)
        code = smap.get(raw)
        if not code:
            unknown.append(raw)
            code = raw
        if submit and price <= 0:
            problems.append("%s: price is missing" % code)
        m = merged.get(code)
        if m:
            if abs(m["price"] - price) > 0.001:
                problems.append("%s: entered twice with different prices" % code)
            m["qty"] += qty
        else:
            merged[code] = {"sku": code, "qty": qty, "price": price}
    ov = body.get("dealer_ov")
    ov_json = None
    if ov:
        ov = dict(ov, name=dealer["name"])
        cd, errs = _clean_dealer(ov, GST_STATES)
        if errs:
            raise ApiError(400, "Dealer details for this order: " + next(iter(errs.values())), fields=errs)
        ov_json = json.dumps({k: cd[k] for k in OV_FIELDS if k != "name"})
    sel = body.get("ship_sel")
    sel_json = None
    if isinstance(sel, dict):
        idx = int(sel.get("idx", -1))
        sel_json = json.dumps({"idx": -1} if idx < 0 else dict(
            {k: str(sel.get(k) or "").strip() for k in ("label", "street", "city", "pin", "state", "country", "gstin")}, idx=idx))
    if submit:
        if unknown:
            raise ApiError(400, "Some SKUs don't exist in the item master", unknown=sorted(set(unknown)))
        if problems:
            raise ApiError(400, problems[0], problems=problems)
        if not merged:
            raise ApiError(400, "Add at least one item with a quantity")
        if not dealer_complete(order_dealer({"dealer_ov": ov_json, "ship_sel": sel_json}, dealer)):
            raise ApiError(400, "Complete the dealer's details (mobile + address) before submitting")
    t = now()
    st = "submitted" if submit else (cur["status"] if cur and cur["status"] == "submitted" else "draft")
    if submit and cur and cur["status"] == "submitted":
        st = "submitted"
    team_id = dealer["team_id"]
    if cur:
        db.q("UPDATE orders SET dealer_id = ?, team_id = ?, po_ref = ?, remarks = ?, status = ?, updated_at = ?, "
             "submitted_at = COALESCE(submitted_at, ?), dealer_ov = ?, ship_sel = ? WHERE id = ?",
             (dealer["id"], team_id, (body.get("po_ref") or "").strip(), (body.get("remarks") or "").strip(), st, t,
              t if submit else None, ov_json, sel_json, cur["id"]))
        oid = cur["id"]
        db.q("DELETE FROM order_lines WHERE order_id = ?", (oid,))
        if cur["status"] == "submitted":
            oq, ov_ = sum(l["qty"] or 0 for l in old_lines), sum((l["qty"] or 0) * (l["price"] or 0) for l in old_lines)
            nq, nv = sum(m["qty"] for m in merged.values()), sum(m["qty"] * m["price"] for m in merged.values())
            ctx.log(oid, "Order edited by the backend team: %d → %d units, ₹%s → ₹%s%s" % (
                oq, nq, format(round(ov_), ","), format(round(nv), ","),
                " (billing sheet was already created — re-download it if ERP needs the change)" if cur["sheet_at"] else ""))
        else:
            ctx.log(oid, "Order updated" + (" and submitted to billing" if submit else ""))
    else:
        s = get_settings(db)
        r = db.one("INSERT INTO orders (dealer_id, team_id, po_ref, remarks, status, created_by, created_at, updated_at, submitted_at, dealer_ov, ship_sel) "
                   "VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
                   (dealer["id"], team_id, (body.get("po_ref") or "").strip(), (body.get("remarks") or "").strip(),
                    st, ctx.name, t, t, t if submit else None, ov_json, sel_json))
        oid = r["id"]
        ref = "%s%d" % (s["ref_prefix"], int(s["ref_start"]) + oid - 1)
        if db.one("SELECT id FROM orders WHERE ref = ?", (ref,)):
            ref = "%s%d-%d" % (s["ref_prefix"], int(s["ref_start"]) + oid - 1, oid)
        db.q("UPDATE orders SET ref = ? WHERE id = ?", (ref, oid))
        ctx.log(oid, "Order created" + (" and submitted to billing" if submit else " as draft"))
    if ov_json and (not cur or cur.get("dealer_ov") != ov_json):
        ctx.log(oid, "Dealer details edited for this order only")
    for m in merged.values():
        db.q("INSERT INTO order_lines (order_id, sku, qty, price) VALUES (?,?,?,?)", (oid, m["sku"], m["qty"], m["price"]))
    o = db.one("SELECT ref, status FROM orders WHERE id = ?", (oid,))
    return {"id": oid, "ref": o["ref"], "status": o["status"], "unknown": sorted(set(unknown))}


def a_order_cancel(ctx, qs, body):
    db = ctx.db
    o = load_order(db, body.get("id"))
    d = db.one("SELECT * FROM dealers WHERE id = ?", (o["dealer_id"],))
    if not can_see_dealer(ctx, d):
        raise ApiError(403, "Not your order")
    if o["status"] == "cancelled":
        raise ApiError(409, "Already cancelled")
    linked = db.one("SELECT id FROM order_links WHERE order_id = ?", (o["id"],))
    if linked and not ctx.is_backend:
        raise ApiError(409, "ERP orders are linked — ask the backend team to cancel it")
    if o["status"] != "draft" and not ctx.is_backend:
        raise ApiError(403, "Once placed, an order can only be cancelled by the backend team")
    reason = (body.get("reason") or "").strip()
    if o["status"] != "draft" and not reason:
        raise ApiError(400, "Give the reason for cancelling")
    db.q("UPDATE orders SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = ?, updated_at = ? WHERE id = ?",
         (reason or None, ctx.name, now(), now(), o["id"]))
    ctx.log(o["id"], ("Order cancelled in full (ERP links kept for reference)" if linked else "Order cancelled")
            + (": " + reason if reason else ""))
    return {"ok": True}


def a_order_close(ctx, qs, body):
    ctx.need_backend()
    db = ctx.db
    o = load_order(db, body.get("id"))
    if body.get("reopen"):
        db.q("UPDATE orders SET closed_at = NULL, closed_by = NULL, close_reason = NULL, updated_at = ? WHERE id = ?",
             (now(), o["id"]))
        ctx.log(o["id"], "Pending quantity reopened")
        return {"ok": True}
    reason = (body.get("reason") or "").strip()
    if not reason:
        raise ApiError(400, "Give a reason for closing the pending quantity")
    db.q("UPDATE orders SET closed_at = ?, closed_by = ?, close_reason = ?, updated_at = ? WHERE id = ?",
         (now(), ctx.name, reason, now(), o["id"]))
    ctx.log(o["id"], "Pending quantity closed: " + reason)
    return {"ok": True}


def a_sheet(ctx, qs, body):
    ctx.need_backend()
    db = ctx.db
    s = get_settings(db)
    ids = body.get("order_ids") or []
    wh = body.get("warehouse") or s["default_warehouse"]
    txn = body.get("transaction_type") or s["default_txn"]
    if not ids:
        raise ApiError(400, "Select at least one order")
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(SHEET_HEADER)
    refs = []
    t = now()
    for oid in ids:
        o = load_order(db, oid)
        if o["status"] != "submitted" or o["closed_at"]:
            raise ApiError(400, "%s isn't open for billing (status: %s)" % (o["ref"], o["status"]))
        d = order_dealer(o, db.one("SELECT * FROM dealers WHERE id = ?", (o["dealer_id"],)))
        if not dealer_complete(d):
            raise ApiError(400, "%s: dealer %s has incomplete details" % (o["ref"], d["name"] if d else "?"))
        lines = db.q("SELECT * FROM order_lines WHERE order_id = ? ORDER BY id", (oid,))
        if not lines:
            raise ApiError(400, "%s has no lines" % o["ref"])
        for i, l in enumerate(lines):
            q = int(l["qty"]) if float(l["qty"]).is_integer() else l["qty"]
            p = int(l["price"]) if float(l["price"]).is_integer() else round(l["price"], 2)
            if i == 0:
                ship = [d["ship_street"], d["ship_city"], d["ship_pin"], d.get("ship_country") or d.get("country") or "IN", d["ship_state"]]
                bill = [d["bill_street"], d["bill_city"], d["bill_pin"], d.get("country") or "IN", d["bill_state"]]
                w.writerow([o["ref"], l["sku"], q, p, d["gstin"] or "", txn, "", d["phone"], d["name"]]
                           + ship + bill + [s["channel_slug"], "", "", "", wh, o["po_ref"] or ""])
            else:
                w.writerow([o["ref"], l["sku"], q, p] + [""] * (len(SHEET_HEADER) - 4))
        db.q("UPDATE orders SET sheet_at = COALESCE(sheet_at, ?), sheet_by = ?, sheet_count = COALESCE(sheet_count, 0) + 1, "
             "warehouse = ?, updated_at = ? WHERE id = ?", (t, ctx.name, wh, t, oid))
        ctx.log(oid, "Billing sheet created (warehouse %s, %s)" % (wh, txn))
        refs.append(o["ref"])
    fname = "Billing_sheet_%s_%s.csv" % ("_".join(refs) if len(refs) <= 3 else "%d_orders" % len(refs),
                                         datetime.datetime.now(IST).strftime("%Y-%m-%d_%H%M"))
    return {"csv": out.getvalue(), "filename": fname}


def _parse_nos(raw):
    if isinstance(raw, list):
        raw = " ".join(str(x) for x in raw)
    toks = [t for t in re.split(r"[\s,;/]+", str(raw or "")) if t]
    good, bad = [], []
    for t in toks:
        t2 = t.lstrip("#")
        (good if ORDER_NO_RE.match(t2) else bad).append(t2)
    seen = []
    for g in good:
        if g not in seen:
            seen.append(g)
    return seen, bad


def _link_checks(ctx, o, nos):
    db = ctx.db
    erp_refresh(db, nos)
    snap = erp_snapshot(db, nos)
    dealer = db.one("SELECT * FROM dealers WHERE id = ?", (o["dealer_id"],))
    my_skus = {l["sku"] for l in db.q("SELECT sku FROM order_lines WHERE order_id = ?", (o["id"],))}
    res = []
    for no in nos:
        s = summarize_no(snap.get(no))
        s["no"] = no
        errors, warns = [], []
        if not s["found"]:
            errors.append("Not found among ERP B2B sales orders")
        else:
            if s["cancelled"]:
                errors.append("ERP order is cancelled")
            if norm_name(s["customer"]) != norm_name(dealer["name"]):
                warns.append("Different customer in ERP: %s (this order is for %s)" % (s["customer"], dealer["name"]))
            if my_skus and not (set(s["skus"]) & my_skus):
                warns.append("None of the SKUs in this ERP order are in %s" % o["ref"])
        already_here = db.one("SELECT id FROM order_links WHERE order_id = ? AND saleor_no = ?", (o["id"], no))
        if already_here:
            errors.append("Already linked to this order")
        others = db.q("SELECT o.ref, d.name AS dealer FROM order_links k JOIN orders o ON o.id = k.order_id "
                      "LEFT JOIN dealers d ON d.id = o.dealer_id WHERE k.saleor_no = ? AND k.order_id <> ?", (no, o["id"]))
        if others:
            warns.append("Also linked to " + ", ".join("%s (%s)" % (x["ref"], x["dealer"]) for x in others)
                         + " — confirm this ERP order covers both")
        s["errors"], s["warnings"] = errors, warns
        res.append(s)
    return res


def a_link_check(ctx, qs, body):
    ctx.need_backend()
    o = load_order(ctx.db, body.get("order_id"))
    if o["status"] != "submitted":
        raise ApiError(400, "%s isn't open for billing" % o["ref"])
    nos, bad = _parse_nos(body.get("numbers"))
    if not nos and not bad:
        raise ApiError(400, "Enter at least one order ID")
    res = _link_checks(ctx, o, nos)
    ctx.db.commit()
    return {"results": res, "invalid": bad}


def a_link_commit(ctx, qs, body):
    ctx.need_backend()
    db = ctx.db
    o = load_order(db, body.get("order_id"))
    if o["status"] != "submitted":
        raise ApiError(400, "%s isn't open for billing" % o["ref"])
    nos, bad = _parse_nos(body.get("numbers"))
    if bad:
        raise ApiError(400, "Not valid order IDs: " + ", ".join(bad))
    res = _link_checks(ctx, o, nos)
    errs = [r for r in res if r["errors"]]
    if errs:
        raise ApiError(400, "%s: %s" % (errs[0]["no"], errs[0]["errors"][0]))
    if any(r["warnings"] for r in res) and not body.get("confirm"):
        raise ApiError(400, "Some IDs have exceptions — tick the confirmation box to link them anyway")
    t = now()
    for r in res:
        db.q("INSERT INTO order_links (order_id, saleor_no, note, flags, linked_by, linked_at) VALUES (?,?,?,?,?,?)",
             (o["id"], r["no"], (body.get("note") or "").strip(), json.dumps(r["warnings"]), ctx.name, t))
        ctx.log(o["id"], "Linked ERP order %s (%s)%s" % (r["no"], r.get("so") or "", " — exception confirmed" if r["warnings"] else ""))
    return {"ok": True, "linked": [r["no"] for r in res]}


def a_unlink(ctx, qs, body):
    ctx.need_backend()
    o = load_order(ctx.db, body.get("order_id"))
    no = str(body.get("no") or "")
    ctx.db.q("DELETE FROM order_links WHERE order_id = ? AND saleor_no = ?", (o["id"], no))
    ctx.log(o["id"], "Unlinked ERP order %s" % no)
    return {"ok": True}


# ---------------------------------------------------------------- daily summary (dashboard view + daily email)
def _inr(n):
    n = int(round(n or 0))
    neg, t = n < 0, str(abs(n))
    if len(t) > 3:
        h, t = t[:-3], t[-3:]
        while len(h) > 2:
            t = h[-2:] + "," + t
            h = h[:-2]
        t = h + "," + t
    return ("-" if neg else "") + "\u20b9" + t


def _units(n):
    return _inr(n)[1:] if (n or 0) >= 0 else _inr(n)


def _esc(x):
    return str(x if x is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _dlabel(d, year=True):
    try:
        x = datetime.date.fromisoformat(d[:10])
    except Exception:
        return d or ""
    return (x.strftime("%a ") if year else "") + str(x.day) + x.strftime(" %b %Y" if year else " %b")


OPEN_STAGES = {"tobill": "Waiting for billing sheet", "sheet": "Sheet made, ERP ID not entered",
               "linked": "ERP ID entered, nothing billed yet", "partial": "Partially billed"}


def digest_data(db, day):
    """Numbers for one day: that day's activity, month to date, per team member, and what needs attention."""
    today = datetime.datetime.now(IST).date().isoformat()
    m0 = day[:8] + "01"
    orders = build_orders(db)
    team = [t for t in db.q("SELECT * FROM team_members WHERE active = 1 ORDER BY name")]
    oday = lambda o: (o["submitted_at"] or o["created_at"] or "")[:10]
    placed = [o for o in orders if o["stage"] != "draft"]
    T = lambda os, k: sum(o["tot"].get(k) or 0 for o in os)

    def block(os):
        canc = [o for o in os if o["stage"] == "cancelled"]
        den = T(os, "ov") - T(canc, "cv")
        return {"n": len(os), "ov": T(os, "ov"), "oq": T(os, "oq"),
                "bv": T(os, "bvo") + T(os, "ev"), "bq": T(os, "bq") + T(os, "eq"), "eq": T(os, "eq"),
                "pv": T(os, "pv"), "pq": T(os, "pq"), "cv": T(os, "cv"),
                "fill": (T(os, "bvo") / den * 100) if den > 0 else 0}

    w0 = (datetime.date.fromisoformat(day) - datetime.timedelta(days=6)).isoformat()
    inr_ = lambda x, f: f <= (x or "")[:10] <= day

    def span(os, f):
        """Activity from f to the chosen day: orders placed, units billed in ERP (by ERP Sales Order date), cancellations."""
        new = [o for o in os if inr_(oday(o), f)]
        canc = [o for o in os if o["stage"] == "cancelled" and inr_(o.get("cancelled_at"), f)]
        shut = [o for o in os if o["stage"] == "closed" and o.get("close_reason") and inr_(o.get("closed_at"), f)]
        bl = [x for o in os for k, x in o["billed_by_day"].items() if f <= k <= day]
        return {"n": len(new), "ov": T(new, "ov"), "oq": T(new, "oq"),
                "bn": len([o for o in os if any(f <= k <= day for k in o["billed_by_day"])]),
                "bv": sum(x[1] for x in bl), "bq": sum(x[0] for x in bl),
                "cn": len(canc) + len(shut), "cv": T(canc, "ov") - T(canc, "bvo") + T(shut, "cv")}

    mtd = [o for o in placed if m0 <= oday(o) <= day]
    rows = []
    ids = {t["id"] for t in team}
    for t in team + [None]:
        mine = (lambda o: o["team_id"] == t["id"]) if t else (lambda o: o["team_id"] not in ids)
        os = [o for o in placed if mine(o)]
        r = {"name": t["name"] if t else "Untagged", "day": span(os, day), "wk": span(os, w0),
             "mtd": block([o for o in mtd if mine(o)])}
        if t or r["mtd"]["n"] or r["wk"]["n"] or r["wk"]["bn"]:
            rows.append(r)
    rows.sort(key=lambda r: (r["name"] == "Untagged", -r["mtd"]["bv"], -r["mtd"]["ov"], r["name"]))

    # needs attention: every open order right now, whatever its date
    def age(o):
        try:
            return (datetime.date.fromisoformat(today) - datetime.date.fromisoformat(oday(o))).days
        except Exception:
            return 0
    open_ = [o for o in placed if o["stage"] in OPEN_STAGES]
    groups = []
    for st, label in OPEN_STAGES.items():
        os = [o for o in open_ if o["stage"] == st]
        groups.append({"k": st, "label": label, "n": len(os), "pv": T(os, "pv"), "pq": T(os, "pq"),
                       "old": max((age(o) for o in os), default=0)})
    bad = sorted({l["no"] for o in placed if o["stage"] != "cancelled" for l in o["links"] if l.get("found") is False})
    oldest = sorted(open_, key=lambda o: (-age(o), o["id"]))[:10]
    last = db.one("SELECT MAX(fetched_at) AS m FROM erp_fetch")
    return {"day": day, "today": today, "m0": m0, "w0": w0, "synced": last["m"] if last else None,
            "dayTot": span(placed, day), "wkTot": span(placed, w0), "mtd": block(mtd), "rows": rows, "groups": groups, "bad": bad,
            "oldest": [{"ref": o["ref"], "dealer": o["dealer"], "team": o["team"] or "Untagged", "date": oday(o), "age": age(o),
                        "stage": OPEN_STAGES[o["stage"]], "pv": o["tot"]["pv"], "pq": o["tot"]["pq"]} for o in oldest]}


SHORT_STAGE = {"tobill": "waiting for a billing sheet", "sheet": "with a sheet but no ERP ID",
               "linked": "with an ERP ID but nothing billed yet", "partial": "partially billed"}


def _lk(n):  # short rupees for email: 1.79 L / 2.3 Cr; below a lakh in full
    n = n or 0
    if abs(n) >= 1e7:
        return "\u20b9%.2f Cr" % (n / 1e7)
    if abs(n) >= 1e5:
        return "\u20b9%.2f L" % (n / 1e5)
    return _inr(n)


def digest_html(d, link=""):
    """Short, phone-friendly email (tables + inline styles); the dashboard shows exactly this."""
    F = "font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;"
    ink, mut, line, acc, warn = "#1d2a30", "#6b7b83", "#e3e8ea", "#0e6e86", "#b4722f"
    D, M = d["dayTot"], d["mtd"]
    dl = _dlabel(d["day"], False)
    pl = lambda n, w="order": "%d %s%s" % (n, w, "" if n == 1 else "s")
    sec = lambda t: f'<div style="{F}font-size:12px;font-weight:700;color:{mut};text-transform:uppercase;letter-spacing:.06em;margin:20px 0 6px">{t}</div>'
    o = [f'<div style="max-width:520px;margin:0 auto;padding:16px 4px;{F}color:{ink}">',
         f'<div style="font-size:18px;font-weight:700">Offline sales &#183; {_dlabel(d["day"])}</div>']

    yest = (datetime.date.fromisoformat(d["today"]) - datetime.timedelta(days=1)).isoformat()
    dh = ("Yesterday" if d["day"] == yest else "Today" if d["day"] == d["today"] else dl)
    th = f'style="{F}font-size:11px;color:{mut};font-weight:600;padding:6px;border-bottom:1px solid {line};text-align:%s"'
    td = f'style="{F}font-size:13px;padding:7px 6px;border-bottom:1px solid {line};text-align:%s;vertical-align:top%s"'
    small = lambda t: f'<div style="font-size:11px;color:{mut};font-weight:400">{t}</div>'
    nil = f'<span style="color:{mut}">&#8212;</span>'

    W = d["wkTot"]
    wl = f'{_dlabel(d["w0"], False)} &#8211; {dl}'
    hd = lambda t, sub_: f'{t}<div style="font-size:10px;font-weight:400">{sub_}</div>'
    cols = [hd(dh, dl) if dh != dl else dh, hd("Last 7 days", wl), hd("Month to date", "by order date")]

    # yesterday, last 7 days and month to date, side by side
    o.append(sec("At a glance"))
    o.append(f'<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">'
             f'<tr><th {th % "left"}></th>' + "".join(f'<th {th % "right"}>{c}</th>' for c in cols) + '</tr>')
    plc = lambda x: (_lk(x["ov"]) + small(pl(x["n"]))) if x["n"] else nil
    bil = lambda x, star="": (f'<b style="color:{acc}">{_lk(x["bv"])}</b>' + small(_units(x["bq"]) + " units" + star)) if x["bq"] else nil
    cxl = lambda x: _lk(x["cv"]) if x["cv"] else nil
    summ = [("Placed", plc(D), plc(W), plc(M)),
            ("Billed", bil(D), bil(W), bil(M, "*" if M["eq"] else "")),
            ("Cancelled / closed", cxl(D), cxl(W), cxl(M)),
            ("Pending to bill", nil, nil, f'<span style="color:{warn if M["pv"] else ink}">{_lk(M["pv"])}</span>'),
            ("Fill rate", nil, nil, "%.0f%%" % M["fill"])]
    for row in summ:
        o.append(f'<tr><td {td % ("left", "")}>{row[0]}</td>' + "".join(f'<td {td % ("right", ";white-space:nowrap")}>{v}</td>' for v in row[1:]) + '</tr>')
    o.append('</table>')

    # team: placed and billed, each for yesterday / last 7 days / month to date
    rows = [r for r in d["rows"] if r["mtd"]["n"] or r["wk"]["n"] or r["wk"]["bq"]]
    if rows:
        tot = [{"name": "Total", "day": D, "wk": W, "mtd": M, "tot": True}] if len(rows) > 1 else []
        short = [dh if dh != dl else dl, "7 days", "MTD"]
        for title, k, extra in (("Team &#183; placed", "ov", False), ("Team &#183; billed", "bv", True)):
            o.append(sec(title))
            o.append(f'<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">'
                     f'<tr><th {th % "left"}>Name</th>' + "".join(f'<th {th % "right"}>{c}</th>' for c in short)
                     + (f'<th {th % "right"}>Fill MTD</th>' if extra else "") + '</tr>')
            for r in rows + tot:
                x = ";font-weight:700" if r.get("tot") else ""
                c = [_lk(r[p][k]) if r[p][k] else nil for p in ("day", "wk", "mtd")]
                if extra:
                    c.append("%.0f%%" % r["mtd"]["fill"] if r["mtd"]["ov"] else nil)
                o.append(f'<tr><td {td % ("left", x)}>{_esc(r["name"])}</td>'
                         + "".join(f'<td {td % ("right", x + ";white-space:nowrap")}>{v}</td>' for v in c) + '</tr>')
            o.append('</table>')

    o.append(f'<div style="font-size:11px;color:{mut};margin-top:18px;line-height:1.5">Values incl. GST. {dh} and last 7 days = what happened on those days (orders placed, units billed in ERP). Month to date = orders placed this month and how far they are billed, as on the dashboard. '
             + (f'* Includes {_units(M["eq"])} extra units billed outside the original orders. ' if M["eq"] else "")
             + (f'<a href="{_esc(link)}" style="color:{acc}">Open the dashboard</a>' if link else "") + '</div></div>')
    return "".join(o)


def a_digest(ctx, qs, body):  # Daily summary tab (backend + Dugout); the daily email uses the same builder
    if not (ctx.is_backend or ctx.is_mgr):
        raise ApiError(403, "Only the backend team and the Dugout can see the daily summary")
    day = (qs.get("date") or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        day = (datetime.datetime.now(IST).date() - datetime.timedelta(days=1)).isoformat()
    d = digest_data(ctx.db, day)
    return {"day": day, "today": d["today"], "subject": "Offline sales \u2014 %s \u00b7 last 7 days \u00b7 month to date" % _dlabel(day), "html": digest_html(d, digest_link(ctx))}


EMAIL_RE = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[A-Za-z]{2,}$")


def mail_sender():
    return (os.environ.get("GMAIL_USER") or "").strip(), (os.environ.get("GMAIL_APP_PASSWORD") or "").replace(" ", "")


def send_mail(to, subject, html):
    """Send through the company Google Workspace mailbox (Gmail SMTP + app password)."""
    import smtplib
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    from email.utils import formataddr
    user, pw = mail_sender()
    if not user or not pw:
        raise ApiError(400, "The sending mailbox isn't connected yet — add GMAIL_USER and GMAIL_APP_PASSWORD in Vercel (Backend → Daily email → How to connect it)")
    m = MIMEMultipart("alternative")
    m["Subject"], m["From"], m["To"] = subject, formataddr(("Ten x You Offline Sales", user)), ", ".join(to)
    m.attach(MIMEText("Daily offline sales summary - please view this email in HTML.", "plain", "utf-8"))
    m.attach(MIMEText('<!doctype html><html><body style="margin:0;background:#ffffff">' + html + "</body></html>", "html", "utf-8"))
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as sm:
            sm.login(user, pw)
            sm.sendmail(user, to, m.as_string())
    except smtplib.SMTPAuthenticationError:
        raise ApiError(400, "Gmail refused the login for %s — check GMAIL_APP_PASSWORD in Vercel (it must be an App Password, not the normal password)" % user)


def recipients(db):
    return db.q("SELECT id, email, name, added_by, added_at FROM digest_recipients ORDER BY LOWER(COALESCE(NULLIF(name, ''), email))")


def digest_link(ctx):
    u = (os.environ.get("DASHBOARD_URL") or "").strip()
    h = getattr(ctx, "host", "") or ""
    return u or ("https://" + h if h and not h.startswith(("localhost", "127.")) else "")


def digest_send(ctx, day, to):
    d = digest_data(ctx.db, day)
    subj = "Offline sales \u2014 %s \u00b7 last 7 days \u00b7 month to date" % _dlabel(day)
    send_mail(to, subj, digest_html(d, digest_link(ctx)))
    return subj


def _last_sent(db):
    r = db.one("SELECT v FROM erp_cache WHERE k = 'digest_last'")
    return json.loads(r["v"]) if r and r["v"] else None


def _set_last_sent(db, v):
    db.q("INSERT INTO erp_cache (k, v, fetched_at) VALUES ('digest_last', ?, ?) "
         "ON CONFLICT (k) DO UPDATE SET v = excluded.v, fetched_at = excluded.fetched_at", (json.dumps(v), now()))


def a_digest_list(ctx, qs, body):  # Backend → Daily email
    ctx.need_backend()
    user, pw = mail_sender()
    return {"recipients": recipients(ctx.db), "sender": user, "connected": bool(user and pw),
            "scheduled": bool(os.environ.get("CRON_SECRET")), "last": _last_sent(ctx.db)}


def a_digest_save(ctx, qs, body):  # add or edit one recipient
    ctx.need_backend()
    db = ctx.db
    email = str(body.get("email") or "").strip().lower()
    name = str(body.get("name") or "").strip()[:80]
    if not EMAIL_RE.match(email):
        raise ApiError(400, "That doesn't look like an email address")
    rid = body.get("id")
    dup = db.one("SELECT id FROM digest_recipients WHERE LOWER(email) = ?", (email,))
    if dup and dup["id"] != rid:
        raise ApiError(400, "%s is already on the list" % email)
    if rid:
        db.q("UPDATE digest_recipients SET email = ?, name = ? WHERE id = ?", (email, name, rid))
    else:
        db.q("INSERT INTO digest_recipients (email, name, added_by, added_at) VALUES (?,?,?,?)", (email, name, ctx.name, now()))
    return {"recipients": recipients(db)}


def a_digest_remove(ctx, qs, body):
    ctx.need_backend()
    ctx.db.q("DELETE FROM digest_recipients WHERE id = ?", (body.get("id"),))
    return {"recipients": recipients(ctx.db)}


def a_digest_send(ctx, qs, body):  # "Send test" to one person, or "Send now" to everyone
    ctx.need_backend()
    day = (datetime.datetime.now(IST).date() - datetime.timedelta(days=1)).isoformat()
    to = [body["to"]] if body.get("to") else [r["email"] for r in recipients(ctx.db)]
    if not to:
        raise ApiError(400, "Add at least one email address first")
    digest_send(ctx, day, to)
    return {"ok": True, "to": to}


def a_digest_cron(ctx, qs, body):  # Vercel Cron, every morning: refresh ERP, then email yesterday's summary
    db = ctx.db
    day = (datetime.datetime.now(IST).date() - datetime.timedelta(days=1)).isoformat()
    last = _last_sent(db) or {}
    if last.get("day") == day and last.get("ok") and qs.get("force") != "1":
        return {"ok": True, "skipped": "already sent for " + day}
    to = [r["email"] for r in recipients(db)]
    if not to:
        return {"ok": True, "skipped": "no recipients"}
    nos = [r["saleor_no"] for r in db.q("SELECT DISTINCT saleor_no FROM order_links")]
    if nos:
        try:
            erp_refresh(db, nos)
            db.commit()
        except Exception:  # send on the last synced figures rather than not at all
            db.rollback()
    try:
        digest_send(ctx, day, to)
        _set_last_sent(db, {"day": day, "at": now(), "to": len(to), "ok": True})
    except Exception as e:
        db.rollback()
        _set_last_sent(db, {"day": day, "at": now(), "to": len(to), "ok": False, "error": getattr(e, "msg", str(e))})
        db.commit()
        raise
    return {"ok": True, "day": day, "to": len(to)}


ACTIONS = {
    "boot": a_boot, "items": a_items, "orders": a_orders,
    "dealer_save": a_dealer_save, "dealer_check": a_dealer_check, "dealer_tag": a_dealer_tag,
    "team_save": a_team_save, "team_delete": a_team_delete, "settings_save": a_settings_save,
    "order_save": a_order_save, "order_cancel": a_order_cancel, "order_close": a_order_close,
    "sheet": a_sheet, "link_check": a_link_check, "link_commit": a_link_commit, "unlink": a_unlink,
    "my_avatar": a_my_avatar, "prefs": a_prefs, "sales": a_sales, "erp_refresh": a_erp_refresh,
    "digest": a_digest, "digest_list": a_digest_list, "digest_save": a_digest_save, "digest_remove": a_digest_remove,
    "digest_send": a_digest_send, "digest_cron": a_digest_cron,
}
DUGOUT_OK = {"boot", "items", "orders", "prefs", "sales", "erp_refresh", "digest"}  # The Dugout is view-only
NO_USER = {"boot", "items", "sales", "erp_refresh", "digest_cron"}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._run("GET")

    def do_POST(self):
        self._run("POST")

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False, default=str, separators=(",", ":")).encode("utf-8")
        gz = len(body) > 1500 and "gzip" in (self.headers.get("Accept-Encoding") or "")
        if gz:
            body = gzip.compress(body, 5)
        self.send_response(code)
        if gz:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _run(self, method):
        u = urllib.parse.urlparse(self.path)
        qs = dict(urllib.parse.parse_qsl(u.query))
        act = qs.get("a", "")
        db = None
        try:
            if act == "digest_cron":  # Vercel Cron signs its call with CRON_SECRET
                sec = os.environ.get("CRON_SECRET") or ""
                if not sec or (self.headers.get("Authorization") or "") != "Bearer " + sec:
                    raise ApiError(401, "Not allowed")
            elif norm_key(self.headers.get("X-Key")) != norm_key(os.environ.get("SITE_PASSWORD") or "Howzat?"):
                raise ApiError(401, "Wrong team password — reload and sign in again")
            fn = ACTIONS.get(act)
            if not fn:
                raise ApiError(404, "Unknown action")
            body = {}
            if method == "POST":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            who = self.headers.get("X-User") or ""
            pin = os.environ.get("BACKEND_PIN")
            if who == "backend" and pin and (self.headers.get("X-Pin") or "").strip() != pin:
                raise ApiError(401, "Backend PIN is wrong", pin=True)
            dpin = os.environ.get("DUGOUT_PIN")
            if who == "dugout" and dpin and (self.headers.get("X-Pin") or "").strip() != dpin:
                raise ApiError(401, "Dugout PIN is wrong", pin=True)
            if who == "dugout" and act not in DUGOUT_OK:
                raise ApiError(403, "The Dugout is view-only")
            db = DB()
            _REQ.db = db
            ensure_schema(db)
            if act in NO_USER:
                class _C:  # read-only actions don't need a resolved user
                    pass
                ctx = _C()
                ctx.db = db
                ctx.is_backend = who == "backend"
            else:
                ctx = Ctx(db, who)
            ctx.host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or ""
            out = fn(ctx, qs, body)
            db.commit()
            self._send(200, out)
        except ApiError as e:
            if db:
                db.rollback()
            self._send(e.code, dict({"error": e.msg}, **e.extra))
        except Exception as e:  # noqa
            if db:
                db.rollback()
            self._send(500, {"error": "%s: %s" % (type(e).__name__, e)})
        finally:
            _REQ.db = None
            if db:
                db.close()
