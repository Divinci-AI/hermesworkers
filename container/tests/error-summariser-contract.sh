#!/usr/bin/env bash
#
# The error-reporter contract, executed INSIDE the real image.
#
# Sibling of config-contract.sh, and it exists for the same reason: this is a
# version-dependent fact about the PINNED hermes-agent source, and no assertion
# on our own scripts' text can see it.
#
# WHAT IT PINS
#
#   `AIAgent._summarize_api_error` must never raise. It is the error REPORTER;
#   when it throws, its own exception replaces the failure it was called to
#   describe, and every caller sees a confident, specific, wrong answer.
#
#   Concretely (production, 2026-08-25): every turn on Team Hermes returned
#
#       HTTP 500: Attempted to access streaming response content,
#                 without having called `read()`.
#
#   an httpx.ResponseNotRead raised by the reporter, while the real failure —
#   a provider 404 — was visible only in the gateway log under "During handling
#   of the above exception". Because the mask names httpx, it reads as a
#   transport bug in OUR client. Two model-swap experiments returned
#   byte-identical errors, since the masking is invariant to the actual cause.
#
#   ⚠️ getattr(response, "text", None) does NOT absorb this. ResponseNotRead is
#   a RuntimeError, not an AttributeError, so the default never applies. That
#   is the whole defect, and it is invisible by inspection — which is why this
#   file runs it.
#
# Fixed by container/patches/0001-summarize-api-error-streaming.patch. This
# test is what proves the patch is IN the image, as opposed to merely being in
# the repo: a patch that silently stopped applying would leave every static
# check green.
set -uo pipefail

PY=/opt/hermes-venv/bin/python
[ -x "$PY" ] || { echo "✗ $PY missing — cannot test the pinned source"; exit 1; }

cd /opt/hermes-agent || { echo "✗ /opt/hermes-agent missing"; exit 1; }

"$PY" - <<'PYEOF'
import sys, traceback

fails = []
def ok(m):  print(f"  ✓ {m}")
def bad(m): print(f"  ✗ {m}"); fails.append(m)

try:
    from run_agent import AIAgent
except Exception as exc:
    print(f"  ✗ cannot import run_agent: {type(exc).__name__}: {exc}")
    traceback.print_exc()
    sys.exit(1)

import httpx
print(f"httpx: {httpx.__version__}")

class _Stream(httpx.SyncByteStream):
    def __iter__(self):
        yield b'{"error":{"message":"Gemini returned HTTP 404"}}'

class ApiErr(Exception):
    status_code = 404
    def __init__(self, resp):
        super().__init__("opaque wrapper error")
        self.response = resp

# 1. THE OUTAGE CASE — an unread streaming response.
try:
    out = AIAgent._summarize_api_error(ApiErr(httpx.Response(404, stream=_Stream())))
except Exception as exc:
    bad(f"summariser RAISED on a streaming response: {type(exc).__name__}: {exc}"
        " — the patch is NOT in this image")
else:
    ok(f"streaming response summarised without raising: {out!r}")
    if "read()" in out:
        bad("summary reports the reporter's own httpx failure, not the upstream error")
    if "Gemini returned HTTP 404" not in out:
        bad(f"the real provider message was lost: {out!r}")
    else:
        ok("the real provider message survived into the summary")

# 2. NO REGRESSION on an ordinary, already-read response.
try:
    out = AIAgent._summarize_api_error(
        ApiErr(httpx.Response(400, content=b'{"error":{"message":"bad request detail"}}')))
except Exception as exc:
    bad(f"summariser raised on a normal response: {type(exc).__name__}: {exc}")
else:
    (ok if "bad request detail" in out else bad)(f"already-read response: {out!r}")

# 3. An error with no .response at all still falls back to str(error).
class Plain(Exception):
    status_code = 500
try:
    out = AIAgent._summarize_api_error(Plain("upstream exploded"))
except Exception as exc:
    bad(f"summariser raised with no response attr: {type(exc).__name__}: {exc}")
else:
    (ok if "upstream exploded" in out else bad)(f"no-response fallback: {out!r}")

# 4. A .text that raises something OTHER than ResponseNotRead must also be
#    contained — the guard is "never raise", not "handle one exception type".
class Hostile:
    @property
    def text(self): raise ValueError("nope")
try:
    out = AIAgent._summarize_api_error(ApiErr(Hostile()))
except Exception as exc:
    bad(f"summariser raised on a hostile .text: {type(exc).__name__}: {exc}")
else:
    ok(f"hostile .text contained: {out!r}")

# 5. _summarize_api_error must remain a STATICMETHOD. run_agent.py calls it
#    both as AIAgent._summarize_api_error(exc) and as self._summarize_api_error(exc);
#    losing the decorator breaks only the second, at runtime, in the error path.
#    A patch that splices a helper between the decorator and the def does
#    exactly that, and it is invisible to any test that calls the class form.
for name in ("_summarize_api_error", "_safe_response_text"):
    raw = AIAgent.__dict__.get(name)
    if raw is None:
        bad(f"{name} is not defined on AIAgent")
    elif not isinstance(raw, staticmethod):
        bad(f"{name} is {type(raw).__name__}, not a staticmethod")
    else:
        ok(f"{name} is a staticmethod")

print()
if fails:
    print(f"FAILED: {len(fails)} error-summariser assertion(s)")
    sys.exit(1)
print("error summariser contract OK")
PYEOF
