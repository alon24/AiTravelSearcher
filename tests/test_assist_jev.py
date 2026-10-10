"""The Airline Assist extension's Jev calls (browser-extension/background.js): through the local Skyhop server, or on
the web version through the Cloudflare Worker the page handed over with its Google sign-in. Runs that part of
background.js in Node with chrome.storage and fetch faked. Skipped without Node."""
import json
import shutil
import subprocess
import time
from pathlib import Path

import pytest

BACKGROUND = Path(__file__).resolve().parent.parent / "browser-extension" / "background.js"
pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node is not installed")
ROUTE = {"url": "https://skyhop-worker.example.workers.dev", "token": "tok-1"}

HARNESS = """
const job = JSON.parse(process.argv[1]), calls = [];
globalThis.chrome = { storage: { local: { get: async () => job.local }, session: { get: async () => ({ jevRoute: job.route }) } } };
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), auth: (init.headers || {}).Authorization || null, body: init.body ? JSON.parse(init.body) : null });
  return new Response(JSON.stringify(job.answer), { status: job.status || 200 });
};
%s
(async () => {
  const out = { decider: await getDecider() };
  try { out.result = job.op === "ping" ? (await deciderPing(), "ok") : await layaClassify("a page", { q: { type: "noul" } }); }
  catch (e) { out.error = e.message; }
  process.stdout.write(JSON.stringify({ ...out, calls }));
})();
"""


def run(op="classify", route=None, local=None, answer=None, status=200):
    src = BACKGROUND.read_text()
    code = src[src.index("const LAYA_URL"):src.index("const PAGE_TYPES")]
    job = {"op": op, "route": route, "local": local or {}, "answer": answer if answer is not None else {"answers": {"q": {"noul": 0.9}}}, "status": status}
    out = subprocess.run(["node", "-e", HARNESS % code, json.dumps(job)], capture_output=True, text=True, timeout=60, check=True)
    return json.loads(out.stdout)


def live(**over):
    return {**ROUTE, "until": int(time.time() * 1000) + 3_000_000, **over}


def test_on_the_web_version_jev_goes_to_the_worker_with_the_sign_in():
    r = run(route=live())
    assert r["decider"] == "jev", "with a Worker and no Laya choice made, Jev is the default"
    assert r["result"] == {"q": {"noul": 0.9}}
    (call,) = r["calls"]
    assert call["url"] == ROUTE["url"] + "/decide" and call["auth"] == "Bearer tok-1"
    assert call["body"] == {"state": "a page", "questions": {"q": {"type": "noul"}}}


def test_without_the_web_version_jev_goes_to_the_local_server():
    r = run(local={"decider": "jev"})
    assert r["calls"][0]["url"] == "http://127.0.0.1:8765/api/decide" and r["calls"][0]["auth"] is None


def test_an_expired_sign_in_is_not_used():
    r = run(route=live(until=1000), local={"decider": "jev"})
    assert r["calls"][0]["url"].startswith("http://127.0.0.1:8765/")
    assert run(route=live(until=1000))["decider"] == "laya"


def test_laya_stays_when_it_was_chosen():
    r = run(route=live(), local={"decider": "laya"})
    assert r["decider"] == "laya" and r["calls"][0]["url"].startswith("http://127.0.0.1:8799/")


def test_the_badge_check_says_what_is_missing_on_the_worker():
    assert run("ping", route=live(), answer={"jev": True, "user": "ilan@example.com"})["result"] == "ok"
    assert "invited" in run("ping", route=live(), answer={"jev": True, "user": None})["error"]
    assert "OpenRouter" in run("ping", route=live(), answer={"jev": False, "user": "ilan@example.com"})["error"]


def test_a_worker_refusal_is_reported():
    r = run(route=live(), answer={"error": "sign in with an allowed Google account"}, status=403)
    assert r["error"] == "Jev via Skyhop's Worker: sign in with an allowed Google account"
