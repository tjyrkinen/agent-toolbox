#!/usr/bin/env python3
"""Single-shot local server that hands a rendered HTML page's committed input
back to the calling agent. No MCP, no external services, stdlib only.

Contract
  GET  /?n=<nonce>  -> serves --page (with --data / nonce injected, see below)
  GET  /ping        -> {"ok":true}  (reachability probe; no nonce)
  POST /submit      -> body JSON must carry {"nonce": <match>}; the whole body is
                       written to --out, the server replies {"ok":true} and shuts
                       down. One commit per run.

The page MUST post with a RELATIVE url (fetch('/submit', ...)), so it always
replies to whichever host:port actually loaded it — no address baked into the
page. That is what makes "which URL is reachable" a non-issue: any that loads works.

Injection (optional): if the page contains the literal tokens, the server
replaces them before serving —
  "__NONCE__"     -> the run nonce (quoted)          e.g.  const NONCE = "__NONCE__";
  __PAGE_DATA__   -> the JSON from --data, or null   e.g.  const PAGE_DATA = __PAGE_DATA__;
so one static scaffold can be reused with per-invocation data.

Reachability: binds 0.0.0.0 and prints EVERY candidate address (see
references/page-contract.md). Surface all printed URL lines to the user in order
— the reachable one varies by environment; do not cherry-pick.
"""
import argparse
import json
import os
import secrets
import socket
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

MAX_SUBMIT_BYTES = 1_048_576
REQUEST_TIMEOUT_SECONDS = 5


def script_json(value):
    """Serialize data for a script element without creating HTML parser tokens."""
    return (
        json.dumps(value, ensure_ascii=False)
        .replace("<", "\\u003c")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def require_fresh_output(out_path):
    """Prevent a previous run's result from being mistaken for this run's commit."""
    if os.path.lexists(out_path):
        raise ValueError(f"output already exists: {out_path}")


def inject_annotate(page, root_sel, nonce, allow_commit=True):
    """Inject the highlight-and-comment toolbox before </body> so any served page
    gains inline annotation with zero page code (see assets/annotate.js)."""
    mod = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "annotate.js")
    js = open(mod, "r", encoding="utf-8").read()
    cfg_obj = {"nonce": nonce}
    if root_sel:
        cfg_obj["root"] = root_sel
    if not allow_commit:
        cfg_obj["commit"] = False
    cfg = "window.__ANNOTATE_CFG__=" + script_json(cfg_obj) + ";"
    block = "<script>" + cfg + "</script>\n<script>\n" + js + "\n</script>"
    i = page.lower().rfind("</body>")
    return page[:i] + block + "\n" + page[i:] if i != -1 else page + "\n" + block


def candidate_ips():
    ips = []
    try:
        out = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=3).stdout
        for tok in out.split():
            if "." in tok and ":" not in tok and tok not in ips:  # IPv4 only, clean URLs
                ips.append(tok)
    except Exception:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2] or []:
            if ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    if "127.0.0.1" not in ips:
        ips.append("127.0.0.1")
    return ips


def build_handler(page_bytes, nonce, out_path, done, state):
    submit_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Allow", "GET, POST, OPTIONS")
            self.end_headers()

        def do_GET(self):
            parsed = urlsplit(self.path)
            path = parsed.path
            if path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
                return
            if path == "/ping":
                return self._send(200, json.dumps({"ok": True}))
            if path in ("/", "/index.html"):
                if parse_qs(parsed.query).get("n") != [nonce]:
                    return self._send(403, json.dumps({"error": "bad nonce"}))
                return self._send(200, page_bytes, "text/html; charset=utf-8")
            self._send(404, json.dumps({"error": "not found"}))

        def do_POST(self):
            if urlsplit(self.path).path != "/submit":
                return self._send(404, json.dumps({"error": "not found"}))
            try:
                n = int(self.headers.get("Content-Length", "0") or "0")
            except ValueError:
                return self._send(400, json.dumps({"error": "invalid content length"}))
            if n < 0:
                return self._send(400, json.dumps({"error": "invalid content length"}))
            if n > MAX_SUBMIT_BYTES:
                return self._send(413, json.dumps({"error": "request too large"}))
            self.connection.settimeout(REQUEST_TIMEOUT_SECONDS)
            try:
                raw = self.rfile.read(n) if n else b""
            except (TimeoutError, socket.timeout):
                return self._send(408, json.dumps({"error": "request timeout"}))
            if len(raw) != n:
                return self._send(400, json.dumps({"error": "incomplete request"}))
            try:
                payload = json.loads(raw.decode("utf-8"))
            except Exception:
                return self._send(400, json.dumps({"error": "invalid json"}))
            # The nonce in the served URL and page is the authorization boundary for
            # both loading the decision surface and committing its result.
            if not isinstance(payload, dict) or payload.get("nonce") != nonce:
                return self._send(403, json.dumps({"error": "bad nonce"}))
            payload.pop("nonce", None)
            with submit_lock:
                if state.get("committed"):
                    return self._send(409, json.dumps({"error": "already committed"}))
                state["committed"] = True
                try:
                    with open(out_path, "x", encoding="utf-8") as f:
                        json.dump(payload, f, indent=2)
                except FileExistsError:
                    return self._send(409, json.dumps({"error": "output already exists"}))
                except OSError:
                    state["committed"] = False
                    return self._send(500, json.dumps({"error": "could not store result"}))
                state["payload"] = payload
            self._send(200, json.dumps({"ok": True}))
            done.set()

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--page", required=True, help="HTML file to serve at /")
    ap.add_argument("--out", required=True, help="where to write the committed JSON")
    ap.add_argument("--data", default=None, help="JSON file injected at the __PAGE_DATA__ token")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=0, help="0 = auto-pick a free port")
    ap.add_argument("--nonce", default=None)
    ap.add_argument("--timeout-sec", type=int, default=0, help="0 = wait indefinitely")
    ap.add_argument("--no-annotate", action="store_true", help="disable the highlight-and-comment toolbox (on by default)")
    ap.add_argument("--annotate-root", default=None, help="CSS selector for the annotatable region (default [data-annotate]||main||body)")
    ap.add_argument("--no-annotate-commit", action="store_true", help="don't add the standalone commit bar (the page provides its own commit)")
    args = ap.parse_args()

    try:
        require_fresh_output(args.out)
    except ValueError as error:
        ap.error(str(error))

    nonce = args.nonce or secrets.token_urlsafe(16)
    page = open(args.page, "r", encoding="utf-8").read()
    if '"__NONCE__"' in page:
        page = page.replace('"__NONCE__"', script_json(nonce))
    if "__PAGE_DATA__" in page:
        if args.data:
            with open(args.data, "r", encoding="utf-8") as data_file:
                data = json.load(data_file)
        else:
            data = None
        page = page.replace("__PAGE_DATA__", script_json(data))
    if not args.no_annotate:
        page = inject_annotate(page, args.annotate_root, nonce, not args.no_annotate_commit)
    page_bytes = page.encode("utf-8")

    done, state = threading.Event(), {}
    httpd = ThreadingHTTPServer((args.host, args.port), build_handler(page_bytes, nonce, args.out, done, state))
    port = httpd.server_address[1]

    ips = candidate_ips()
    print(f"NONCE {nonce}", flush=True)
    print(f"PORT {port}", flush=True)
    print(f"PRIMARY {ips[0]}", flush=True)
    for ip in ips:
        print(f"URL http://{ip}:{port}/?n={nonce}", flush=True)
    print("READY", flush=True)

    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    fired = done.wait(timeout=args.timeout_sec or None)
    if not fired:
        print("TIMEOUT no commit received", flush=True)
        httpd.shutdown()
        raise SystemExit(2)
    threading.Timer(0.4, httpd.shutdown).start()  # let the 200 flush
    t.join(timeout=5)
    print("COMMITTED " + json.dumps(state.get("payload", {}))[:2000], flush=True)


if __name__ == "__main__":
    main()
