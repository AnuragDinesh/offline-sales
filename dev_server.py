"""
Local preview server — mimics Vercel: serves index.html / static files and routes
/api/data and /api/billing to the same handler code that runs on Vercel.

    set ERP_API_KEY=...  &  set ERP_API_SECRET=...
    python dev_server.py            -> http://localhost:8787

Without DATABASE_URL the billing API uses a local SQLite file (local-billing.db).
"""
import importlib.util, os, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, "api", name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


APIS = {"/api/data": load("data"), "/api/billing": load("billing")}


class Dev(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def __getattr__(self, name):  # borrow helper methods (_run, _send) from the active API handler
        mod = self.__dict__.get("_mod")
        if mod and hasattr(mod.handler, name):
            return getattr(mod.handler, name).__get__(self)
        raise AttributeError(name)

    def _api(self, method):
        mod = APIS.get(self.path.split("?")[0])
        if not mod:
            return False
        self._mod = mod
        fn = getattr(mod.handler, "do_" + method, None)
        if not fn:
            self.send_error(405)
            return True
        fn(self)
        return True

    def end_headers(self):  # never let the browser keep an old copy of the app
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if not self._api("GET"):
            super().do_GET()

    def do_POST(self):
        if not self._api("POST"):
            self.send_error(404)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    print("Serving on http://localhost:%d" % port)
    ThreadingHTTPServer(("127.0.0.1", port), Dev).serve_forever()
