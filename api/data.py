"""
Vercel Python serverless function: /api/data
Pulls the Ten x You Offline Sales dataset live from ERPNext (erp.tenxyou.com)
and returns the JSON the dashboard consumes.

- ERP credentials come ONLY from environment variables (never hard-coded):
    ERP_API_KEY, ERP_API_SECRET     (set these in Vercel -> Project -> Settings -> Environment Variables)
- Response is edge-cached for 1 hour (s-maxage=3600), so the dashboard auto-refreshes hourly
  while the ERP is hit at most ~once per hour.

Logic mirrors the validated pull: B2B sales orders (custom_is_b2b=1) from START_DATE,
cancelled excluded, net of B2B return delivery notes, marketplace dealers excluded by default,
colour/size/product enriched from the Item master.
"""
from http.server import BaseHTTPRequestHandler
import json, os, re, collections, datetime, urllib.parse, urllib.request

BASE = "https://erp.tenxyou.com"
START_DATE = "2026-07-01"                       # data window: July 2026 onwards
MARKETPLACE_KEYWORDS = ["myntra", "jabong", "cocoblu", "flipkart", "reliance", "zilo"]
PALETTE = ["#0e6e86", "#4e63a6", "#9a5e7f", "#3f8a6e", "#b4722f",
           "#7a5cb0", "#2f8fb4", "#a34d5e", "#6b8f2f", "#c06a4a"]


def _headers():
    key = os.environ.get("ERP_API_KEY", "")
    secret = os.environ.get("ERP_API_SECRET", "")
    if not key or not secret:
        raise RuntimeError("ERP_API_KEY / ERP_API_SECRET environment variables are not set")
    return {"Authorization": "token %s:%s" % (key, secret)}


def _query(doctype, fields, filters, limit=0):
    params = urllib.parse.urlencode({
        "filters": json.dumps(filters),
        "fields": json.dumps(fields),
        "limit_page_length": limit,
    })
    url = BASE + "/api/resource/" + urllib.parse.quote(doctype) + "?" + params
    req = urllib.request.Request(url, headers=_headers())
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.load(resp).get("data", [])


def _norm(name):
    name = (name or "").strip()
    name = re.sub(r"[-\s]+(Billing|Shipping)?[-\s]*\d+$", "", name, flags=re.I).strip()
    name = re.sub(r"\s+-\s*$", "", name).strip()
    return name


def _is_marketplace(name):
    low = name.lower()
    return any(k in low for k in MARKETPLACE_KEYWORDS)


def build():
    # 1. All non-cancelled B2B sales-order line items (one joined query)
    so = _query(
        "Sales Order",
        ["customer", "transaction_date",
         "`tabSales Order Item`.item_code", "`tabSales Order Item`.qty", "`tabSales Order Item`.amount"],
        [["custom_is_b2b", "=", 1], ["transaction_date", ">=", START_DATE], ["status", "!=", "Cancelled"]],
    )
    # 2. B2B return delivery-note line items (negative amounts)
    dn = _query(
        "Delivery Note",
        ["customer", "posting_date",
         "`tabDelivery Note Item`.item_code", "`tabDelivery Note Item`.qty", "`tabDelivery Note Item`.amount"],
        [["custom_is_b2b", "=", 1], ["is_return", "=", 1], ["posting_date", ">=", START_DATE]],
    )

    off_lines, ret_lines = [], []
    mkt_value = collections.defaultdict(float)
    for r in so:
        dealer = _norm(r.get("customer"))
        if _is_marketplace(dealer):
            mkt_value[dealer] += r.get("amount") or 0
        else:
            off_lines.append({"d": r.get("transaction_date"), "r": 0, "k": dealer,
                              "s": r.get("item_code"), "q": r.get("qty") or 0, "a": r.get("amount") or 0})
    for r in dn:
        dealer = _norm(r.get("customer"))
        if not _is_marketplace(dealer):
            ret_lines.append({"d": r.get("posting_date"), "r": 1, "k": dealer,
                              "s": r.get("item_code"), "q": r.get("qty") or 0, "a": r.get("amount") or 0})

    # 3. Item master attributes (colour / size / product name) for the SKUs seen
    skus = sorted({x["s"] for x in off_lines + ret_lines if x["s"]})
    attr = {}
    for i in range(0, len(skus), 150):
        rows = _query("Item",
                      ["item_code", "item_name", "custom_color", "custom_size"],
                      [["item_code", "in", skus[i:i + 150]]])
        for r in rows:
            attr[r["item_code"]] = r

    def enrich(sku):
        a = attr.get(sku, {})
        return (a.get("item_name") or sku, a.get("custom_color") or "-", str(a.get("custom_size") or "-"))

    lines = []
    for x in off_lines + ret_lines:
        p, c, z = enrich(x["s"])
        lines.append({"d": x["d"], "r": x["r"], "k": x["k"], "s": x["s"], "p": p, "c": c, "z": z,
                      "q": round(x["q"], 2), "a": round(x["a"], 2)})

    off_value = collections.defaultdict(float)
    for x in lines:
        off_value[x["k"]] += x["a"]
    dealers = [{"name": k, "team": None, "excluded": False, "value": round(v)} for k, v in off_value.items()]
    dealers += [{"name": k, "team": None, "excluded": True, "value": round(v)} for k, v in mkt_value.items()]
    dealers.sort(key=lambda d: -d["value"])

    monthly_map = collections.defaultdict(float)
    for x in lines:
        monthly_map[x["d"][:7]] += x["a"]
    monthly = [{"m": m, "v": round(monthly_map[m])} for m in sorted(monthly_map)]

    now = datetime.datetime.now()
    return {
        "today": now.date().isoformat(),
        "generatedAt": now.isoformat(timespec="minutes"),
        "minDate": min(x["d"] for x in lines) if lines else START_DATE,
        "palette": PALETTE,
        "teamMembers": [],       # team roster is built by the user in Management (stored per-browser)
        "teamColors": {},
        "lines": lines,
        "dealers": dealers,
        "monthly": monthly,
        "netTotal": round(sum(x["a"] for x in lines)),
    }


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            body = json.dumps(build(), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:  # noqa
            payload = json.dumps({"error": str(e)}).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(payload)
