"use strict";
/* UI language. English is the source text: a string in the code is its own key, and i18n-he.js maps it to Hebrew.
   The language is fixed per page load (browser language, or the picker in Help, saved in skyhop.helpLang);
   changing it reloads the page. Static text in index.html is translated once here; text built by h() (app.js)
   is translated as it is created; text with numbers or names in it goes through tx("... {n} ...", { n }). */
const I18n = (() => {
  const KEY = "skyhop.helpLang";
  const saved = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  const pick = () => { const l = saved(); return l === "he" || l === "en" ? l : /^he\b/i.test(navigator.language || "") ? "he" : "en"; };
  const lang = pick(), he = lang === "he", HE = window.SKYHOP_HE || { words: {}, plural: {} };

  const tr = s => (he && typeof s === "string" && HE.words[s]) || s;
  const t = (s, vars) => { const out = tr(s); return vars ? out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : out; };
  /** "3 nights" / "1 night": English adds an s, Hebrew has its own word for one and for many. */
  const plural = (n, w) => {
    const forms = he && HE.plural[w];
    return forms ? (n === 1 ? forms[0] : `${n} ${forms[1]}`) : `${n} ${w === "child" && n !== 1 ? "children" : w + (n === 1 ? "" : "s")}`;
  };
  /** Text that comes from the engine or the Worker (warnings, errors, flight-gap notes): sentence patterns in i18n-he.js, applied in order. */
  const tw = s => {
    if (!he || typeof s !== "string") return s;
    if (HE.words[s]) return HE.words[s];
    let out = s;
    for (const [re, to] of HE.patterns || []) out = out.replace(re, to);
    return out;
  };
  const setLang = l => { try { localStorage.setItem(KEY, JSON.stringify(l)); } catch { /* private mode */ } location.reload(); };

  const ATTRS = ["title", "aria-label", "placeholder", "alt"];
  /** Translate the text and the title/aria-label/placeholder of everything under root (index.html is written in English). */
  function apply(root) {
    if (!he) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const m = n.nodeValue.match(/^(\s*)([\s\S]*?)(\s*)$/), key = m[2].replace(/\s+/g, " ");
      if (key && HE.words[key]) n.nodeValue = m[1] + HE.words[key] + m[3];
    }
    for (const el of root.querySelectorAll("[title],[aria-label],[placeholder],[alt]")) {
      for (const a of ATTRS) if (el.hasAttribute(a)) el.setAttribute(a, tr(el.getAttribute(a)));
    }
  }
  if (he) {
    document.documentElement.lang = "he"; document.documentElement.dir = "rtl";
    document.title = tr(document.title);
    const d = document.querySelector("meta[name=description]"); if (d) d.content = tr(d.content);
    apply(document.body);
  }
  return { lang, he, dir: he ? "rtl" : "ltr", tr, t, tw, plural, setLang, apply, locale: he ? "he-IL" : "en-GB" };
})();
const { t: tx, tr, tw, plural } = I18n;
