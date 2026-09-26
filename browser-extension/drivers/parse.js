// Language-neutral reading of what a results page shows, shared by drivers/results.js (injected before it) and
// tested on its own (tests/test_assist_registry.py). Laya can't read numbers, so times, prices and "which label means
// select" are plain code -- and must cope with the languages Skyhop meets:
//   - digits: Arabic-Indic (٠-٩) and Persian (۰-۹) are turned into 0-9 first;
//   - prices: symbol before ("€ 113.24", "$90") or after ("113,24 €", "7 500 ₽", "45,99 lei"), with a decimal
//     point or comma and space / dot / comma thousands ("1.234,56 €", "RON 1,299.00");
//   - times: 24-hour ("16:40") and 12-hour ("2:30 PM", "2:30pm", "2:30 p.m.") -- always returned as 24-hour "HH:MM" so
//     they compare with Skyhop's departure time; a bare "3:55" (one-digit hour, no AM/PM) is not a time (durations);
//   - select words: English, French, German, Romanian, Russian, Arabic, Hebrew, Spanish, Italian, Turkish.
(() => {
  if (window.__skyhopParse) return;

  const norm = (s) => String(s ?? "")
    .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660)
    .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0)
    .replace(/[  ]/g, " ");

  const SYM = "(?:[€£$₪₽₺]|(?<![A-Za-z])(?:EUR|GBP|USD|ILS|HUF|RON|RUB|CHF|TRY|AED|SAR|RSD|BGN|PLN|CZK|lei|LEI|Lei)(?![A-Za-z]))";
  const NUM = "\\d(?:[\\d.,]|\\s(?=\\d{3}(?!\\d)))*";
  const BEFORE = new RegExp(SYM + "\\s?(" + NUM + ")");
  const AFTER = new RegExp("(" + NUM + ")\\s?" + SYM);

  // "1.234,56" / "1,234.56" / "113,24" / "1,299" / "7 500" -> number
  function toNumber(raw) {
    const s = raw.replace(/\s/g, "");
    const c = s.lastIndexOf(","), d = s.lastIndexOf(".");
    let out;
    if (c >= 0 && d >= 0) out = c > d ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");   // the later one is the decimal
    else if (c >= 0 || d >= 0) {
      const sep = c >= 0 ? "," : ".", n = s.split(sep).length - 1, tail = s.length - s.lastIndexOf(sep) - 1;
      out = n > 1 || tail === 3 ? s.split(sep).join("") : s.replace(sep, ".");                        // 1,299 / 1.234.567 are thousands
    } else out = s;
    const v = parseFloat(out);
    return Number.isFinite(v) ? v : null;
  }

  // First price in the text (whichever of symbol-before / symbol-after comes first), or null.
  function priceIn(text) {
    const s = norm(text), a = BEFORE.exec(s), b = AFTER.exec(s);
    const m = !a ? b : !b ? a : (a.index <= b.index ? a : b);
    return m ? toNumber(m[1]) : null;
  }

  // hour:minute with an optional AM/PM marker; validated and converted in timesIn().
  const TIME = /\b(\d{1,2}):([0-5]\d)(?:\s?([AaPp])\.?[Mm]\.?)?(?![\d:])/g;
  function timesIn(text) {
    const out = [];
    for (const m of norm(text).matchAll(TIME)) {
      let h = parseInt(m[1], 10);
      if (m[3]) {                                   // 12-hour clock: 12 AM = 00, 12 PM = 12
        if (h < 1 || h > 12) continue;
        h = h % 12 + (m[3].toLowerCase() === "p" ? 12 : 0);
      } else if (m[1].length !== 2 || h > 23) continue;   // 24-hour clock needs a two-digit hour
      out.push(String(h).padStart(2, "0") + ":" + m[2]);
    }
    return out;
  }

  // A label that says "pick this": English, French, German, Romanian, Russian, Arabic, Hebrew, Spanish, Italian, Turkish.
  const SELECT_WORD = new RegExp([
    "select", "choose", "pick", "book", "continue", "reserve",                       // en
    "s[ée]lection", "choisi", "r[ée]serv", "continuer",                              // fr
    "wähl", "buch", "auswahl",                                                       // de
    "alege", "selecte", "rezerv", "continu",                                         // ro
    "выбор", "выбр", "выбер", "бронир", "забронир", "продолж",                       // ru
    "اختر", "اختيار", "احجز", "حجز", "تحديد", "متابعة",                              // ar
    "בחר", "בחירה", "הזמ",                                                           // he
    "selecc", "elegir", "selezion", "scegli", "seç",                                 // es, it, tr
  ].join("|"), "i");

  window.__skyhopParse = { norm, priceIn, timesIn, TIME, SELECT_WORD, toNumber };
})();
