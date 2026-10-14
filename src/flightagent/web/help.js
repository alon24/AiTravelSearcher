"use strict";
/* Help: a "?" button on every screen opens a Help panel with a guided tour of the screen you are on, the other tours,
   and quick answers, in English or Hebrew (the browser's language, or the one picked in Help or on a tour).
   A plain visit (not a Travel Hub or shared link) starts the welcome tour until it is finished or "Don't show this again".
   A tour step points at a real element (spotlight + bubble); steps whose element isn't on screen right now are skipped,
   so one script serves desktop and phone, before and after a search. Uses app.js globals (h, $, $$, store, Mobile). */
const Help = (() => {
  const SEEN = "skyhop.tour";   // "seen" once the welcome tour was finished or turned off ("Don't show this again")
  const byLink = !!(location.search || location.hash);   // read now: the app tidies a Travel Hub or invite link out of the address

  // ---------------------------------------------------------------- the tours
  // Where each step points: a selector (the first visible match wins) or a list of them; null = a centred card.
  // The words live in TEXT below, one [title, text] per step in the same order, in each language.
  const TOURS = {
    search: { steps: [
      null, [".wz-head"], ["#form .row.two"], ["#form .row.dates [data-wstep='2']"], { el: ["#expert"], target: el => el.closest(".field") },
      ["#more"], [".wz-nav .wz-next"], ["#go"], ["#steps"], ["#history", "#menu"], [".m-nav"], ["#tb-launch"], ["#chat-launch"], [".help-btn"]] },
    results: { steps: [
      [".res-head"], [".res-tabs"], ["#air-sticky .ab", "#air-sticky"], [".m-tabs"], [".m-picks .m-card", ".picks", ".cmp"], [".m-tools"],
      [".trip-rows"], [".m-nav"], [".res-pane:not([hidden]) .card.trip .actions", ".card.trip .actions"]] },
    builder: { open: () => Builder.open(), steps: [["#tb .tb-head"], ["#tb-body"], ["#tb-foot"]] },
    chat: { open: () => $("#chat-launch").click(), available: () => !$("#chat-launch").hidden,
      steps: [["#chat-form", "#chat-signin"], ["#chat-summarize"], ["#chat-share", "#chat-invite"], ["#chat-close"]] },
  };
  const TEXT = {
    en: {
      dir: "ltr", help: "Help", helpSub: "A guided tour of this screen, the other tours, and quick answers.", close: "Close help",
      here: "▶ Tour this screen: ", other: "Other tours", answers: "Quick answers", lang: "Language",
      autoTour: "Show the welcome tour when I open Skyhop", count: (i, n) => `${i} of ${n}`,
      skip: "Skip", never: "Don't show this again", back: "‹ Back", next: "Next ›", done: "Done",
      tours: {
        search: ["Welcome to Skyhop", "Where everything is, and how a search works", [
          ["Welcome to Skyhop", "Skyhop checks every day in your dates, mixes airlines and finds the cheapest trip. This short tour shows where everything is. You can reopen it any time from the ? button."],
          ["Four short steps", "On a phone the search is a wizard: Where, When, Who, then Review. Tap a step to jump back to it."],
          ["Where", "From is your home airport. In To, add one or more places: Skyhop compares them all in one search."],
          ["When", "Earliest departure and latest return are a flexible window, not exact dates. Skyhop tries every departure day inside it."],
          ["How long", "By default any trip length that fits your dates. Turn on Expert mode to ask for, say, exactly 4 nights or 5 to 7."],
          ["More options", "Fly home from another city (open-jaw), travel between your destinations, separate tickets through a hub, and bags."],
          ["Next step", "Next moves on to When, Who and a final Review. Search now runs the search with what is filled in so far."],
          ["Search", "When the trip looks right, press Find flights. The results open below the form."],
          ["Your steps", "1 Trip reopens the search to edit it. 2 Airlines filters airlines after a search. 3 Compare jumps to the results."],
          ["Past searches", "Every search is kept here. Click one to open it again instantly, without searching again."],
          ["Getting around", "This bar is always here: Search edits the trip, Trips and Days show the results, Ask chats with Skyhop, and Trip opens your Trip builder."],
          ["Trip builder", "Collect flights from different searches into one trip, any flight for any leg. Skyhop checks the time and airport between them."],
          ["Ask Skyhop", "Rather type it? Describe the trip in your own words and Skyhop runs the search for you."],
          ["Help is always here", "Lost on any screen? Press ? for a tour of that screen and quick answers."]]],
        results: ["Reading the results", "The best picks, the three views, and how to book", [
          ["Your search", "What you searched, and how many prices were checked. Edit changes the search; Search again fetches fresh prices."],
          ["Three views", "Trips has the best picks and the top trips. Price by day shows the price for each departure day. Mix & match lets you pick each flight yourself."],
          ["Airlines", "The airlines found on this route, cheapest first. Choose Only or Exclude on one to filter the results at once."],
          ["Three views", "Trips lists every trip, Days shows the price for each departure day, and Mix & match lets you pick each flight yourself."],
          ["The best picks", "Cheapest, best value (price weighed against travel time) and fastest. Open one to see its flights and the buttons to book them."],
          ["Filter the list", "Tap a destination, a trip length or Direct to narrow the list, and sort it the way you like."],
          ["More trips", "The next best trips, one line each. Click a line to open its flights."],
          ["Getting around", "Search takes you back to edit the trip, Trips and Days switch views, and Trip opens your Trip builder."],
          ["Book it", "Skyhop never sells tickets. The airline buttons open the airline's own site with the flight filled in. You can also add the flights to the Trip builder or save them to Travel Hub."]]],
        builder: ["Trip builder", "Build one trip from flights you collect", [
          ["Trip builder", "Your own trip, one leg at a time. Add flights from any search with “Add to Trip builder”, or add a leg here and pick from every flight that day."],
          ["Legs", "Each leg shows its chosen flight. Skyhop warns you if the time or the airport between two legs doesn't work."],
          ["Total and next steps", "The total for the whole trip. Save it to Travel Hub, copy a summary to send, or clear it and start over."]]],
        chat: ["Ask Skyhop", "Search by chatting, then share the trip", [
          ["Just say it", "Write where, when and what matters, like “Portugal for a week in late November, direct only”. Skyhop searches and shows the results beside the chat."],
          ["Summarize", "Turns the conversation into a short trip brief you can come back to later."],
          ["Plan together", "Share makes it a shared trip: friends join by link and can ask Skyhop too."],
          ["Back to the search", "Close the chat to return to the page. Your conversation is kept."]]],
      },
      faq: [
        ["Are these prices real?", "With the DEMO DATA badge, no: they are made up so you can try Skyhop. Sign in with Google to search real fares."],
        ["Can I buy tickets here?", "No. Skyhop finds the flights; the airline buttons open the airline's own site, where you book and pay."],
        ["What is open-jaw?", "Flying into one city and home from another, like into Lisbon and home from Porto. Set it in More options → Fly home from."],
        ["What is self-transfer?", "Two separate tickets through a hub. It can be much cheaper, but you collect and re-check your bags, and a delay is your risk."],
        ["How do I go back to an earlier search?", "Open Past searches (the side bar, or ☰ on a phone) and click it. It opens instantly from what was saved."],
        ["How do I send flights to Travel Hub?", "Press “Save to Travel Hub” on a trip or in the Trip builder. The flights land on your trip next to its hotels and map."]],
    },
    he: {
      dir: "rtl", help: "עזרה", helpSub: "סיור מודרך במסך הזה, הסיורים האחרים ותשובות מהירות.", close: "סגירת העזרה",
      here: "◀ סיור במסך הזה: ", other: "סיורים נוספים", answers: "תשובות מהירות", lang: "שפה",
      autoTour: "להציג את סיור הפתיחה כשאני פותח את Skyhop", count: (i, n) => `${i} מתוך ${n}`,
      skip: "דלג", never: "אל תציג שוב", back: "הקודם", next: "הבא", done: "סיום",
      tours: {
        search: ["ברוכים הבאים ל-Skyhop", "איפה כל דבר נמצא, ואיך עושים חיפוש", [
          ["ברוכים הבאים ל-Skyhop", "Skyhop בודק כל יום בטווח התאריכים שלך, משלב חברות תעופה ומוצא את הטיול הזול ביותר. הסיור הקצר הזה מראה איפה כל דבר נמצא. אפשר לפתוח אותו שוב בכל רגע מכפתור ? שבראש המסך."],
          ["ארבעה צעדים קצרים", "בטלפון החיפוש הוא אשף: לאן (Where), מתי (When), מי (Who) ואז סיכום (Review). לוחצים על צעד כדי לחזור אליו."],
          ["לאן", "ב-From שמים את שדה התעופה שממנו יוצאים. ב-To מוסיפים יעד אחד או כמה: Skyhop משווה את כולם בחיפוש אחד."],
          ["מתי", "יציאה מוקדמת וחזרה אחרונה הם טווח גמיש, לא תאריכים מדויקים. Skyhop בודק כל יום יציאה בתוך הטווח."],
          ["כמה זמן", "כברירת מחדל, כל אורך טיול שנכנס בתאריכים. מדליקים Expert mode כדי לבקש, למשל, בדיוק 4 לילות או בין 5 ל-7."],
          ["אפשרויות נוספות", "ב-More options: חזרה מעיר אחרת (open-jaw), טיסות בין היעדים, כרטיסים נפרדים דרך שדה ביניים, ומזוודות."],
          ["הצעד הבא", "הכפתור Next עובר ל-When, ל-Who ולסיכום. Search now מחפש מיד עם מה שכבר מולא."],
          ["חיפוש", "כשהטיול נראה נכון, לוחצים Find flights. התוצאות נפתחות מתחת לטופס."],
          ["הצעדים שלך", "1 Trip פותח שוב את החיפוש לעריכה. 2 Airlines מסנן חברות תעופה אחרי חיפוש. 3 Compare קופץ לתוצאות."],
          ["חיפושים קודמים", "כל חיפוש נשמר כאן. לוחצים עליו כדי לפתוח אותו מיד, בלי לחפש מחדש."],
          ["ניווט", "הסרגל הזה תמיד כאן: Search לעריכת הטיול, Trips ו-Days לתוצאות, Ask לשיחה עם Skyhop, ו-Trip לבונה הטיולים."],
          ["בונה הטיולים", "אוספים טיסות מחיפושים שונים לטיול אחד, כל טיסה לכל קטע. Skyhop בודק את הזמן ושדה התעופה ביניהן."],
          ["שאל את Skyhop", "מעדיפים לכתוב? מתארים את הטיול במילים שלכם ו-Skyhop מריץ את החיפוש בשבילכם."],
          ["העזרה תמיד כאן", "הלכתם לאיבוד באיזה מסך? לוחצים ? לסיור במסך ולתשובות מהירות."]]],
        results: ["איך קוראים את התוצאות", "ההמלצות, שלוש התצוגות, ואיך מזמינים", [
          ["החיפוש שלך", "מה חיפשת וכמה מחירים נבדקו. Edit משנה את החיפוש; Search again מביא מחירים עדכניים."],
          ["שלוש תצוגות", "ב-Trips ההמלצות והטיולים המובילים. Price by day מראה את המחיר לכל יום יציאה. Mix & match נותן לבחור כל טיסה בעצמך."],
          ["חברות תעופה", "חברות התעופה שנמצאו בקו, מהזולה. Only או Exclude על אחת מסננים את התוצאות מיד."],
          ["שלוש תצוגות", "Trips מציג את כל הטיולים, Days את המחיר לכל יום יציאה, ו-Mix & match נותן לבחור כל טיסה בעצמך."],
          ["ההמלצות", "הזול ביותר, המשתלם ביותר (מחיר מול זמן נסיעה) והמהיר ביותר. פותחים אחת כדי לראות את הטיסות ואת כפתורי ההזמנה."],
          ["סינון הרשימה", "לוחצים על יעד, אורך טיול או Direct כדי לצמצם את הרשימה, וממיינים כמו שנוח."],
          ["עוד טיולים", "הטיולים הטובים הבאים, שורה אחת לכל טיול. לוחצים על שורה כדי לפתוח את הטיסות."],
          ["ניווט", "Search מחזיר לעריכת הטיול, Trips ו-Days מחליפים תצוגה, ו-Trip פותח את בונה הטיולים."],
          ["הזמנה", "Skyhop לא מוכר כרטיסים. כפתורי חברות התעופה פותחים את האתר של החברה עם הטיסה ממולאת. אפשר גם להוסיף את הטיסות לבונה הטיולים או לשמור אותן ב-Travel Hub."]]],
        builder: ["בונה הטיולים", "בונים טיול אחד מטיסות שאספתם", [
          ["בונה הטיולים", "הטיול שלכם, קטע אחרי קטע. מוסיפים טיסות מכל חיפוש עם “Add to Trip builder”, או מוסיפים קטע כאן ובוחרים מכל הטיסות באותו יום."],
          ["קטעים", "כל קטע מראה את הטיסה שנבחרה. Skyhop מזהיר אם הזמן או שדה התעופה בין שני קטעים לא מסתדרים."],
          ["סה״כ והמשך", "המחיר לכל הטיול. שומרים ל-Travel Hub, מעתיקים סיכום לשליחה, או מנקים ומתחילים מחדש."]]],
        chat: ["שאל את Skyhop", "מחפשים בשיחה, ואז משתפים את הטיול", [
          ["פשוט תגידו", "כותבים לאן, מתי ומה חשוב, למשל “פורטוגל לשבוע בסוף נובמבר, רק ישירות”. Skyhop מחפש ומראה את התוצאות ליד השיחה."],
          ["סיכום", "Summarize הופך את השיחה לתקציר טיול קצר שאפשר לחזור אליו."],
          ["מתכננים יחד", "Share הופך את השיחה לטיול משותף: חברים מצטרפים בקישור ויכולים לשאול את Skyhop גם הם."],
          ["חזרה לחיפוש", "סוגרים את השיחה כדי לחזור לדף. השיחה נשמרת."]]],
      },
      faq: [
        ["המחירים אמיתיים?", "כשמופיע התג DEMO DATA, לא: הם ממוצאים כדי שתוכלו לנסות. מתחברים עם Google כדי לחפש מחירים אמיתיים."],
        ["אפשר לקנות כרטיסים כאן?", "לא. Skyhop מוצא את הטיסות; כפתורי חברות התעופה פותחים את האתר של החברה, ושם מזמינים ומשלמים."],
        ["מה זה open-jaw?", "טסים לעיר אחת וחוזרים מאחרת, למשל לליסבון וחזרה מפורטו. מגדירים ב-More options ← Fly home from."],
        ["מה זה self-transfer?", "שני כרטיסים נפרדים דרך שדה ביניים. יכול להיות הרבה יותר זול, אבל אוספים ומעבירים מזוודות לבד, ועיכוב הוא על אחריותכם."],
        ["איך חוזרים לחיפוש קודם?", "פותחים את Past searches (בסרגל הצד, או ☰ בטלפון) ולוחצים עליו. הוא נפתח מיד ממה שנשמר."],
        ["איך שולחים טיסות ל-Travel Hub?", "לוחצים “Save to Travel Hub” על טיול או בבונה הטיולים. הטיסות נכנסות לטיול שלכם ליד המלונות והמפה."]],
    },
  };
  const LANG = "skyhop.helpLang";
  const lang = () => { const l = store.get(LANG); return TEXT[l] ? l : /^he\b/i.test(navigator.language || "") ? "he" : "en"; };
  const T = () => TEXT[lang()];
  const setLang = l => { store.set(LANG, l); if (run) { const { name, i } = run; close(false); begin(name, i); } if (panel) openPanel(); };
  const langPick = () => h("div", { class: "help-lang", role: "radiogroup", "aria-label": T().lang },
    [["en", "English"], ["he", "עברית"]].map(([k, label]) => h("button", { type: "button", role: "radio", lang: k, "aria-checked": String(lang() === k), onclick: () => setLang(k) }, label)));

  // ---------------------------------------------------------------- which screen are we on
  function current() {
    if (!$("#tb").hidden) return "builder";
    if (!$("#chat").hidden) return "chat";
    if ($(".res-head") && $("#step-panel").hidden) return "results";
    return "search";
  }

  // ---------------------------------------------------------------- tour engine
  const shown = el => {   // laid out, visible, and not parked off-canvas (the phone's closed side bar)
    if (!el || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.right > 0 && r.left < innerWidth;
  };
  function targetOf(step) {
    if (!step.el) return null;
    for (const sel of step.el) {
      const el = $$(sel).find(shown);
      if (el) return step.target ? step.target(el) : el;
    }
    return undefined;   // the step points at something not on screen now: skip it
  }
  let run = null;   // { name, steps: [{step, el}], i, layer, hole, tip }
  function start(name) {
    close(false);
    const tour = TOURS[name];
    if (tour.open && current() !== name) { tour.open(); setTimeout(() => begin(name), 260); return; }   // after the drawer slides in
    begin(name);
  }
  function begin(name, at = 0) {
    const words = T().tours[name][2];
    const steps = TOURS[name].steps.map((where, k) => ({ step: { ...(Array.isArray(where) || !where ? { el: where } : where), title: words[k][0], text: words[k][1] }, k }))
      .map(x => ({ ...x, el: targetOf(x.step) })).filter(x => x.el !== undefined);
    if (!steps.length) return;
    const hole = h("div", { class: "tour-hole", "aria-hidden": "true" });
    const tip = h("div", { class: "tour-tip", role: "dialog", "aria-modal": "true", "aria-labelledby": "tour-title", dir: T().dir, lang: lang() });
    const layer = h("div", { class: "tour", "data-tour": name }, hole, tip);
    document.body.append(layer);
    run = { name, steps, i: 0, layer, hole, tip };
    addEventListener("resize", place); addEventListener("scroll", place, true);
    show(Math.min(at, steps.length - 1));
  }
  function show(i) {
    run.i = i;
    const { step, el } = run.steps[i], n = run.steps.length, last = i === n - 1, t = T();
    run.tip.replaceChildren(
      h("div", { class: "tour-top" }, h("span", { class: "tour-count" }, t.count(i + 1, n)), langPick()),
      h("h3", { id: "tour-title" }, step.title),
      h("p", {}, step.text),
      h("div", { class: "tour-nav" },
        last ? null : h("button", { type: "button", class: "btn ghost tour-skip", onclick: () => close(false) }, t.skip),
        i > 0 ? h("button", { type: "button", class: "btn tour-back", onclick: () => show(i - 1) }, t.back) : null,
        h("button", { type: "button", class: "btn primary tour-next", onclick: () => (last ? close() : show(i + 1)) }, last ? t.done : t.next)),
      run.name === "search" && store.get(SEEN) !== "seen"
        ? h("button", { type: "button", class: "tour-never", onclick: () => { store.set(SEEN, "seen"); close(false); } }, t.never) : null);
    if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
    place();
    $(".tour-next", run.tip).focus();
  }
  function place() {
    if (!run) return;
    const { el } = run.steps[run.i], { hole, tip } = run, pad = 6, gap = 12, vw = innerWidth, vh = innerHeight;
    run.layer.classList.toggle("centred", !el);
    if (!el) { hole.style.cssText = ""; tip.style.cssText = ""; return; }
    const r = el.getBoundingClientRect();
    Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
    const tw = Math.min(360, vw - 24), th = tip.offsetHeight;
    const below = r.bottom + pad + gap, above = r.top - pad - gap - th;
    const top = below + th <= vh - 8 ? below : above >= 8 ? above : Math.max(8, vh - th - 8);
    const left = Math.max(12, Math.min(vw - tw - 12, r.left + r.width / 2 - tw / 2));
    Object.assign(tip.style, { width: `${tw}px`, left: `${left}px`, top: `${top}px` });
  }
  /** Done marks the welcome tour as seen; Skip and Escape only close it, so it comes back next visit until "Don't show this again". */
  function close(remember = true) {
    if (!run) return;
    if (remember && run.name === "search") store.set(SEEN, "seen");
    run.layer.remove(); run = null;
    removeEventListener("resize", place); removeEventListener("scroll", place, true);
  }

  // ---------------------------------------------------------------- help panel
  let panel = null;
  function openPanel() {
    closePanel();
    const here = current(), t = T();
    const others = Object.keys(TOURS).filter(k => k !== here && (!TOURS[k].available || TOURS[k].available()));
    const tourBtn = (k, primary) => h("button", { type: "button", class: "help-tour" + (primary ? " here" : ""), "data-help-tour": k, onclick: () => { closePanel(); start(k); } },
      h("b", {}, (primary ? t.here : "") + t.tours[k][0]), h("span", {}, t.tours[k][1]));
    const auto = h("input", { type: "checkbox", class: "help-auto", checked: store.get(SEEN) !== "seen",
      onchange: e => store.set(SEEN, e.target.checked ? null : "seen") });
    panel = h("div", { class: "help-wrap" },
      h("div", { class: "tb-scrim help-scrim", onclick: closePanel }),
      h("aside", { class: "tb help open", role: "dialog", "aria-label": t.help, dir: t.dir, lang: lang() },
        h("div", { class: "tb-head" }, h("div", {}, h("h2", {}, t.help), h("p", {}, t.helpSub)),
          h("button", { type: "button", class: "btn icon-btn help-close", "aria-label": t.close, onclick: closePanel }, "✕")),
        h("div", { class: "tb-body" },
          h("div", { class: "help-row" }, h("span", { class: "help-h" }, t.lang), langPick()),
          tourBtn(here, true),
          h("label", { class: "switch help-auto-row" }, auto, ` ${t.autoTour}`),
          h("h3", { class: "help-h" }, t.other), others.map(k => tourBtn(k, false)),
          h("h3", { class: "help-h" }, t.answers),
          t.faq.map(([q, a]) => h("details", { class: "help-faq" }, h("summary", {}, q), h("p", {}, a))))));
    document.body.append(panel);
    $(".help-tour.here", panel).focus();
  }
  function closePanel() { if (panel) { panel.remove(); panel = null; } }

  function init() {
    $$(".help-btn").forEach(b => b.addEventListener("click", openPanel));
    document.addEventListener("keydown", e => {
      if (run) {
        if (e.key === "Escape") close(false);
        else if (e.key === "ArrowRight" && run.i < run.steps.length - 1) show(run.i + 1);
        else if (e.key === "ArrowLeft" && run.i > 0) show(run.i - 1);
        else return;
        e.stopImmediatePropagation(); e.preventDefault();
      } else if (panel && e.key === "Escape") { closePanel(); e.stopImmediatePropagation(); }
    }, true);
    // A plain visit gets the welcome tour until it is done or turned off; a Travel Hub or shared link opens straight on its search.
    if (!store.get(SEEN) && !byLink) setTimeout(() => { if (!run && !panel) start("search"); }, 400);
  }
  return { init, start, close, openPanel, current };
})();
