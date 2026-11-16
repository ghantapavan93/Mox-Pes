"""Print a Playwright trace's timeline on one wall clock: actions, call-log lines, network, console.

    python -I C:/Temp/stab/read-trace.py <unzipped trace dir> [url-substring ...]

Times are seconds relative to the first printed event. Network lines show the request's start and
its total duration; with url substrings given, only matching requests are printed.
"""
import datetime
import glob
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
root = sys.argv[1]
url_filters = sys.argv[2:]


def lines(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


out = []
for path in sorted(glob.glob(os.path.join(root, "*-trace.trace"))):
    wall0 = mono0 = None
    for e in lines(path):
        kind = e.get("type")
        if kind == "context-options":
            wall0, mono0 = e.get("wallTime"), e.get("monotonicTime")
            continue
        if wall0 is None:
            continue
        wall = lambda m: wall0 + (m - mono0)  # noqa: E731
        if kind == "before":
            params = {k: v for k, v in (e.get("params") or {}).items() if k not in ("timeout",)}
            out.append((wall(e["startTime"]), "action", f'#{e.get("callId")} {e.get("method")} {json.dumps(params, ensure_ascii=False)[:170]}'))
        elif kind == "after":
            err = (e.get("error") or {}).get("message", "") if isinstance(e.get("error"), dict) else ""
            out.append((wall(e["endTime"]), "end", f'#{e.get("callId")} {("ERROR " + err[:120]) if err else "ok"}'))
        elif kind == "log":
            out.append((wall(e["time"]), "log", f'#{e.get("callId")} {e.get("message", "")[:170]}'))
        elif kind == "console":
            out.append((wall(e["time"]), "console", f'{e.get("messageType")}: {e.get("text", "")[:200]}'))
        elif kind == "event" and e.get("method") == "pageError":
            out.append((wall(e["time"]), "pageerror", json.dumps(e.get("params"))[:200]))

for path in sorted(glob.glob(os.path.join(root, "*-trace.network"))):
    for e in lines(path):
        snap = e.get("snapshot", {})
        req, res = snap.get("request", {}), snap.get("response", {})
        url = req.get("url", "")
        if url_filters and not any(s in url for s in url_filters):
            continue
        started = datetime.datetime.fromisoformat(snap["startedDateTime"].replace("Z", "+00:00")).timestamp() * 1000
        rsc = any(h.get("name", "").lower() == "rsc" for h in req.get("headers", []))
        out.append((started, "network", f'{req.get("method")} {url.replace("http://localhost:3000", "")[:140]}{" [RSC]" if rsc else ""} -> {res.get("status")} in {snap.get("time", 0):.0f} ms'))

out.sort(key=lambda r: r[0])
base = out[0][0] if out else 0
for t, kind, text in out:
    print(f"{(t - base) / 1000:9.3f}  {kind:9s} {text}")
