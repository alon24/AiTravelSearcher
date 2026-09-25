// Shared helper injected (before an airline driver) into the airline's tab: lets a driver find page
// elements ON THE FLY with Laya instead of hard-coding selectors. Laya is a small typed-question
// classifier (see ~/laya-service, docs/DESIGN.md), not an LLM: it can answer "does this statement hold
// for this text?" -- it cannot read prices, write selectors or click. So the split is:
//   Laya  -> which element is "the button that declines cookies", what kind of page is this;
//   code  -> read times/prices with regexes, verify the click had the expected effect.
//
// The service is called by background.js (an extension service worker may fetch http://127.0.0.1:8799;
// the airline's page itself may not), so every call here is a chrome.runtime message.
//
// Measured accuracy (2026-09-25, see docs/DESIGN.md): one binary question per candidate is usable but
// its margins are thin (a "Sign in" link once outscored "Search"), so pick() never trusts the top
// score blindly: it needs a minimum score, vetoes labels that could spend money or leave the flow,
// tries the best few candidates in order and checks each click with a caller-supplied verify().
(() => {
  if (window.__skyhopLaya) return;

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false, error: chrome.runtime.lastError?.message || "no response" }));
    } catch (e) { resolve({ ok: false, error: String(e?.message || e) }); }
  });

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && cs.visibility !== "hidden" && cs.display !== "none";
  };

  // What a person would read on the element: its label, placeholder, or visible text.
  const labelOf = (el) => (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.title
    || el.innerText || el.value || "").replace(/\s+/g, " ").trim().slice(0, 80);

  const describe = (el) => `${el.tagName.toLowerCase()}${el.type && el.tagName === "INPUT" ? " type=" + el.type : ""} "${labelOf(el)}"`;

  // Money can be spent or the flow left by these; never a valid answer to a pick() question.
  const VETO = /sign.?in|log.?in|register|pay(ment)?\b|purchase|checkout|passenger|book now|continue to/i;

  // querySelectorAll that also looks inside OPEN shadow roots (cookie banners such as Usercentrics live
  // in one, so a plain document query never sees their buttons).
  function deepAll(root, selector, out = []) {
    for (const el of root.querySelectorAll(selector)) out.push(el);
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot) deepAll(host.shadowRoot, selector, out);
    return out;
  }

  // Text of any open shadow root, so "is there a consent banner?" can be asked of them too.
  const shadowText = () => deepAll(document, "*").filter((e) => e.shadowRoot).map((e) => e.shadowRoot.textContent || "").join(" ");

  function candidates(root = document, selector = "button, a, input, [role=button], [role=option], [role=radio], [role=combobox]", cap = 40) {
    const seen = new Set();
    const out = [];
    for (const el of deepAll(root, selector)) {
      if (!visible(el)) continue;
      const text = describe(el);
      if (labelOf(el) === "" || seen.has(text)) continue;   // unlabeled, or the same label twice
      seen.add(text);
      out.push({ el, text });
      if (out.length >= cap) break;
    }
    return out;
  }

  // Score each candidate with Laya: "is this page element <role>?" -> probability in [0,1].
  async function rank(role, cands) {
    const r = await send({ type: "laya-rank", role, states: cands.map((c) => "Page element: " + c.text) });
    if (!r.ok) throw new Error("Laya: " + r.error);
    return cands.map((c, i) => ({ ...c, score: r.scores[i] })).sort((a, b) => b.score - a.score);
  }

  // Find `role` among the candidates and act on it. Returns {el, score} for the first candidate whose
  // act() is confirmed by verify(); null if none passed (never acts on a candidate below minScore).
  async function pick(role, { root, selector, act, verify, minScore = 0.6, tries = 3, log = () => {} } = {}) {
    const ranked = await rank(role, candidates(root, selector));
    log(`Laya ranking for "${role}": ` + ranked.slice(0, 4).map((c) => `${c.score.toFixed(2)} ${c.text}`).join(" | "));
    let n = 0;
    for (const c of ranked) {
      if (n >= tries || c.score < minScore) break;
      if (VETO.test(c.text)) continue;
      n++;
      act(c.el);
      await new Promise((r) => setTimeout(r, 700));
      if (!verify || await verify(c.el)) return { el: c.el, score: c.score, text: c.text };
      log(`click on ${c.text} did not have the expected effect, trying the next candidate`);
    }
    return null;
  }

  // What kind of page is this? 'results' | 'consent' | 'captcha' | 'blocked' | 'no_flights' | 'other' | null (Laya down)
  async function pageType(text) {
    const r = await send({ type: "laya-page", text: String(text).slice(0, 4000) });
    return r.ok ? r.choice : null;
  }

  window.__skyhopLaya = { deepAll, shadowText, visible, labelOf, describe, candidates, rank, pick, pageType, ping: () => send({ type: "laya-ping" }) };
})();
