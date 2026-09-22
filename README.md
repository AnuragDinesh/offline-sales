# Ten × You — Offline Sales Dashboard (Vercel)

Live, hourly-refreshing offline-sales dashboard. A static page (`index.html`) that fetches
its data from a Python serverless function (`api/data.py`) which pulls **live from ERPNext**
(`erp.tenxyou.com`) and returns it as JSON. The ERP response is edge-cached for **1 hour**, so
the dashboard stays current while the ERP is hit at most ~once per hour.

## What's in here
```
index.html        the dashboard (fetches /api/data on load; real CSV/XLSX downloads)
api/data.py        serverless function: pulls B2B sales orders (net of returns) from ERPNext
vercel.json        function config (30s max duration)
requirements.txt   none needed (standard library only)
```

## The one thing you MUST set — ERP credentials (as environment variables)
The function reads the ERP token from env vars so it is **never** committed to the repo:

| Variable | Value |
|---|---|
| `ERP_API_KEY`    | `71d0b78b9c2be91` |
| `ERP_API_SECRET` | `05421c02af38118` |

> These are the current API key/secret. If the token is ever rotated in ERPNext, just update
> `ERP_API_SECRET` in Vercel and redeploy — no code change.

---

## Deploy — Option A: Vercel dashboard (no CLI needed)
1. Put this `vercel-app` folder in a Git repo (GitHub/GitLab/Bitbucket) and push it.
2. Go to **vercel.com → Add New → Project → Import** that repo.
3. Framework preset: **Other**. Root directory: the folder containing `index.html`.
4. Open **Settings → Environment Variables**, add `ERP_API_KEY` and `ERP_API_SECRET` (values above)
   for **Production** (and Preview if you want).
5. Click **Deploy**. You'll get a URL like `https://offline-sales-xxxx.vercel.app`.

## Deploy — Option B: Vercel CLI
```bash
npm i -g vercel          # needs Node.js
cd vercel-app
vercel                   # first run: link/create the project
vercel env add ERP_API_KEY        # paste 71d0b78b9c2be91  (choose Production)
vercel env add ERP_API_SECRET     # paste 05421c02af38118  (choose Production)
vercel --prod            # deploy to production
```

## Verify after deploy
- Open `https://<your-app>.vercel.app/api/data` → you should see JSON (dealers, lines, monthly…).
  If you see `{"error": "...ERP_API_KEY... not set"}`, the env vars aren't set for that environment.
- Open the site → enter password **Howzat?** → the dashboard loads live data.
- Try **Export CSV / Export XLS** on any table — these now download real files.

## Notes
- **Password gate ("Howzat?")** is client-side (in `index.html`), matching the demo. For a
  hard, server-enforced gate over the whole site, enable **Vercel → Settings → Deployment
  Protection → Password Protection** (Pro plan) — that sits in front of everything, including
  `/api/data`.
- **Team members, colours and dealer tagging** save in each viewer's browser (localStorage), by
  design — they persist per person/device and are not shared. (Moving these to a shared store is a
  later upgrade if you want everyone to see the same tagging.)
- **Data window:** July 2026 onward (`START_DATE` in `api/data.py`). Marketplace dealers
  (Cocoblu/Myntra/Flipkart/Reliance/Zilo…) are excluded by default; adjust the tagging in the
  Management tab.
- **Refresh cadence:** hourly via the `Cache-Control: s-maxage=3600` header on the function. To
  force-refresh, redeploy or wait out the hour.
