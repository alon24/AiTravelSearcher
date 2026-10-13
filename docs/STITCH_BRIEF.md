# Skyhop: design brief for Google Stitch

> **Palette superseded (2026-10-11):** the colours and font below are the original brief. The live palette is the suite's
> green, see `docs/stitch/DESIGN.md`.

Use this to generate or redesign the Skyhop UI in [Google Stitch](https://stitch.withgoogle.com).
Stitch takes a text prompt (and optionally an image) and can generate several screens at once. It exports
to Figma or to front-end code (HTML/CSS, Tailwind and others).

**How to use**
1. Attach a screenshot of the current UI (open https://alon24.github.io/AiTravelSearcher/, run a search, screenshot it).
2. Paste the **Master prompt** (section 1). Let Stitch generate the first screen.
3. Paste each **screen prompt** (section 3) as a new screen or an edit. Attach the sample data (section 4) so
   the mocks are realistic.
4. Export **HTML/CSS** (plain, no framework) or copy to Figma. Bring it back and see section 6.

---

## 1. Master prompt (paste first)

> Design a responsive web app called **Skyhop**: a flight search tool that finds the cheapest trips across
> flexible dates and several destinations at once. The user enters where they fly from, one or more
> destinations, a date window and a trip length in nights. The app checks every day in the window, mixes
> airlines, and shows the cheapest and best-value trips, with a price-by-day chart.
>
> **Vibe:** young, fresh, playful but trustworthy. Big friendly headings, generous whitespace, rounded
> cards, soft glow shadows, one bold violet-to-pink gradient used sparingly for the main call to action and
> the "cheapest" highlight. Not corporate, not cluttered. Money and dates must be instantly scannable.
>
> **Design tokens (use exactly):**
> - Font: Plus Jakarta Sans (400 to 800). Headings 800, tight tracking. Numbers in prices use bold weight.
> - Light: background `#f6f4ff`, card `#ffffff`, ink `#1a1633`, secondary text `#57537a`, hairlines `#e9e6f7`.
> - Dark: background `#0d0c1b`, card `#171532`, ink `#f5f3ff`, secondary `#bdb9dc`, hairlines `#2b2850`.
> - Accent gradient: `#6d4aff` → `#c44cff` → `#ff4f9a` (120deg). Accent solid `#6d4aff` (light), `#9a83ff` (dark).
> - Chart series colours (data marks only, in this order): `#2a78d6`, `#eb6834`, `#1baf7a`, `#eda100`,
>   `#e87ba4`, `#008300`, `#4a3aa7`, `#e34948`. Dark mode: `#3987e5`, `#d95926`, `#199e70`, `#c98500`,
>   `#d55181`, `#008300`, `#9085e9`, `#e66767`.
> - Status: warning amber (`#fff3d6` bg / `#8a4b00` text), success green, error red. Always paired with an icon and text.
> - Radius 14px inputs, 20px cards, pill chips. Inputs 48px tall. Buttons 44px minimum touch target.
>
> Provide **light and dark** themes. FULL-SCREEN desktop (the layout fills the whole browser window: fixed left sidebar plus a main area that stretches to the right edge, no centred max-width column; 1440-2560px first, 1280px laptops must still work). Mobile (390px) comes later, plus a
> mobile layout (390px) where the sidebar becomes a slide-in drawer. Accessible: WCAG AA contrast, visible
> focus rings, labels on all fields, chart also available as a table.

## 2. Product facts Stitch should respect

- One primary action per screen: **Find flights**.
- Money is always shown as whole units with a currency symbol (`$141`), never cents.
- Dates: `Sat 17 Oct`. Times 24-hour: `19:40`. Durations: `3h 50m`.
- Destinations are airports or "All airports" city groups (`ROM · Rome`, `CDG · Paris`), shown as removable chips.
- Searches can take from seconds to a few minutes, so progress must be visible and calm.
- The free data source is limited, so the app shows an estimate ("about 28 lookups, 14 cached, free") before searching.

## 3. Screen prompts

### A. Search home
> Screen "Search". Left sidebar (300px): logo mark (gradient rounded square with a plane) and wordmark
> "Skyhop", a "+ New search" button, then the heading "Past searches" (see screen E). Main area, centred:
> headline "Fly somewhere **for less.**" (the last words in the gradient), one-line subtitle "Pick a few
> cities and a flexible window. Skyhop checks every day, mixes airlines and finds the cheapest trip." Then one
> large card containing the form:
> - Row 1: **From** (single airport field with a removable chip "TLV · Tel-aviv") and **To** (multi-select
>   field with chips "ROM · Rome", "CDG · Paris" and an "Add another…" input; helper text "add several to
>   compare"). An open autocomplete dropdown listing airports: code badge, city bold, airport name and country muted.
> - Row 2: **Earliest departure** and **Latest return** date fields, and **Nights** as two steppers
>   (− 4 +) to (− 7 +) with three small preset pills: Weekend, Week, Two weeks.
> - Row 3: **Stops (each way)** segmented control (Direct / Up to 1 / Up to 2, selected item filled with the
>   gradient), **Currency** select, **Travellers** stepper.
> - A collapsed "More options" disclosure (see below).
> - Footer: on the left a status line with a green dot, "≈ 28 lookups · 14 cached · free"; on the right the
>   large gradient button "Find flights →".
> Also show the expanded "More options": Fly home from (different airport), toggles (Also fly between my
> destinations, Same airline both ways, Allow separate tickets with hub chips IST, ATH), Self-transfer
> buffer hours, Max travel per direction, Layover between (hours) from to, a slider "Value of an hour of
> travel $10/h" with helper text, Top picks to show, Max lookups per search.

### B. Searching (progress)
> Screen "Searching". Same page, the form stays; below it a card with a gently floating plane emoji,
> "Checking flights… 37 of 120", a rounded gradient progress bar at 30%, and a muted line "TLV → ROM, CDG ·
> every day from 12 Oct to 22 Oct". The sidebar shows the running search with a "30%" pill.

### C. Results dashboard
> Screen "Results". Below the form: title "TLV → ROM, CDG" with meta "12 Oct – 22 Oct · 4–5 nights", pills
> "28 lookups · gflights ×14 · 14 cached", "7.5s", "just now", and buttons "Edit" and "Search again".
> Then three pick cards side by side: **Cheapest** (gradient card, white text, `$141`, "ROM · Sat 17 Oct →
> Wed 21 Oct", "4 nights · direct · 7h 20m in transit"), **Best value**, **Cheapest direct** (white cards).
> Then a chart card "Price by departure day" with a segmented control (Cheapest | Best value) and (Chart |
> Table). The chart is a column chart, one thin rounded column (max 24px wide, 2px gaps) per departure day,
> coloured by destination with a small legend, y-axis in dollars, x-axis "12 Oct, 13 Oct…", only the lowest
> column labelled with its price, the selected column at full strength and the others faded. Show a hover
> tooltip: "Mon 12 Oct → Sat 17 Oct / **$192** / ● ROM · 5 nights / W4 · direct · 7h 20m". Below: "Selected
> day" with one trip card (see D) and "Top picks overall" with more trip cards.

### D. Trip card
> A card with: destination "ROM" large, optional pills ("Open-jaw", "Multi-city", "Self-transfer"), dates
> "Sat 17 Oct → Wed 21 Oct · 4 nights", total price `$141` large on the right with "value score 218" small.
> Inside, one rounded inner panel per leg. Leg header: "Outbound" bold, "Sat 17 Oct · 3h 50m · direct" muted,
> leg price right. Each flight row: flight code badge (`W46044`), "19:40 TLV → 22:30 FCO", airline name muted,
> and "+1" when it lands next day. Between flights a layover pill "2h 15m layover in ATH" (green normally,
> amber if 8h or more). Under warnings, amber rows with a ⚠ icon ("SELF-TRANSFER via IST: separate tickets,
> collect and re-check bags") and blue info rows with an ℹ icon. Buttons: "Google Flights ↗" and one per
> airline ("Wizz Air ↗").

### E. Past searches
> The sidebar list. Each item: bold route "TLV → ROM, CDG", muted "12 Oct – 22 Oct · 4–5 nights", and a
> footer with bold "from $141" (or a "45%" running pill, a red "Failed" pill, or an amber "No flights"
> pill) and "2h ago". The active item is a white card with a border and shadow. A small × appears on
> hover to delete. Include an empty state: "Your searches will show up here." Mobile: this list is a drawer
> opened from a ☰ button in a top bar, with a dimmed scrim.

### F. States
> Show: form validation error banner (red, "The return date must be after the departure date."), over-budget
> estimate line in red ("Too big: 420 lookups needed, max is 400. Narrow the dates or cities."), no-results
> note (amber, "No trips matched. Try more stops, a wider window or a longer layover limit."), and a failed
> search with a "Try again" button. Also the loading state of the chart holding its previous render at reduced opacity.

### G. Mobile (390px)
> Stack all form rows into one column, full-width primary button, pick cards stacked, the chart scrollable
> with fewer x labels, trip-card segments stacked vertically, sidebar as drawer.

## 4. Sample data (use for realistic mocks)

- Search: TLV → ROM (Rome), CDG (Paris); 12 Oct – 22 Oct 2026; 4–5 nights; up to 1 stop; USD.
- Cheapest: ROM, Sat 17 Oct → Wed 21 Oct, **$141**, direct, 7h 20m. Outbound W46044 Wizz Air TLV 19:40 → FCO
  22:30 ($65). Return W46041 FCO 05:30 → TLV 10:00 ($76).
- Daily cheapest (12 to 18 Oct): 192, 169, 196, 155, 203, 141, 170. Paris is higher (about 440 round trip).
- Other airlines: Tus Air U8132 (TLV 15:10 → FCO 17:55, $161), Israir 6H343 ($180), El Al LY285 ($436), SKY express GQ721 via ATH ($175, 1 stop, layover 8h 25m: show the amber pill).
- Self-transfer example: TLV → IST (Turkish TK787 08:30 → 11:00) then IST → ROM (Pegasus PC1234 15:30 → 16:55), 4h 30m gap, warning shown.

## 5. Component inventory (design each with hover, focus, disabled)

Autocomplete combobox with chips; date field; stepper; segmented control; toggle switch; range slider;
disclosure ("More options"); primary gradient button, secondary button, ghost/icon button; badge/pill
(neutral, running, success, warning, error); pick card (hero and normal); column chart with legend and
tooltip; data table; trip card and leg panel; layover pill; warning row; progress bar; toast/banner; sidebar item;
theme toggle.

## 6. After the export (what we do with it)

The current UI is plain HTML, CSS and vanilla JavaScript served by the API, with no build step. Ask Stitch for
**plain HTML/CSS (no framework)** with **CSS custom properties for every colour**. Then:

1. Keep `web/app.js` (behaviour) and re-skin: replace `web/style.css` and the static markup in `web/index.html`.
2. `app.js` depends on these hooks; keep them or update the script:
   `#form #ac-from #ac-to #ac-back #ac-hubs #start #end #nmin #nmax input[name=stops] #currency #adults #more
   #connect #same #st #buffer #maxtravel #laymin #laymax #vot #vot-out #top #maxcalls #form-error #estimate
   #estimate-text #go #results #history #new-search #menu #sidebar #scrim .theme-toggle #tooltip
   [data-step] [data-for] [data-nights]`.
3. The **results screen is built in JavaScript** (`renderResult`, `tripCard`, `drawChart`). Stitch's design for
   screens B to F is applied by matching class names and styles there, not by pasting its HTML.
4. The chart is drawn as SVG by `drawChart`. Take Stitch's spacing, colours and typography, not its chart markup.
5. Check both themes, keyboard focus and the 390px layout before committing.

## 7. Acceptance checklist

- [ ] Both themes; text contrast AA; focus ring on every control.
- [ ] Only one gradient call to action per screen.
- [ ] Prices, dates, times and durations formatted as in section 2.
- [ ] Chart also reachable as a table; colour is never the only signal.
- [ ] Works at 390px and 1440px; no horizontal page scroll.
- [ ] Reduced-motion users see no floating or sliding animation.


---

## 8. Added since this brief was written (paste as extra screens or edits, 26 Sept 2026)

These features exist in the app now and have no design yet.

### H. Trip length: simple and expert mode
> Design the **Trip length** field of the search form (a 300px-wide column next to the two date fields "Earliest departure" and
> "Latest return"). Label "TRIP LENGTH" with a small Nights / Days segmented control on the right.
> **Simple state (default):** an "Expert mode" switch (off) and one calm sentence: "Any length that fits your dates: 1-20 nights
> (2-21 days)." Nothing else, so the default stays effortless.
> **Expert state:** the switch is on. A two-option segmented control "Exactly | Between". Below it, for *Between* two steppers
> "5 - to - 7" (minus, number, plus each) and for *Exactly* one full-width stepper "4". Three preset pills: Weekend, Week, Two weeks.
> A hint line: "Between 4-6 nights (5-7 days). Your dates allow up to 20 nights."
> **Validation state:** the second number can never be lower than the first. Show an amber note under the steppers, "The second
> number can't be lower than the first, so it was raised to match", and a second variant "Your dates allow at most 5 nights, so the
> length was set to fit". Light and dark.

### I. Header badges
> The page header shows, right of the title, three small pills: **LIVE** (green), **ASSIST ON** (green, with a plane icon) and a
> decision-model pill "Laya" or "Jev" with a brain icon. The model pill is a button: amber with "x not running" when the chosen model
> can't be reached, with a tooltip. Also design ASSIST OFF (amber). Keep them compact and calm.

### J. Airline filter bar
> A sticky bar at the top of the results: label "AIRLINES", one chip per airline found ("Wizz Air | ONLY", "Israir | ONLY",
> "ITA | ONLY"). Excluded airlines are struck through and dimmed. At the right: "Show all" and "Filter on: 1 of 5 airlines used".
> Design normal, excluded and hover states, and how the bar collapses on mobile.

### K. Mix and match flights
> Under the price-by-day chart: "Mix & match flights". A warning strip when an airline filter hides flights ("Airline filter on
> (only Wizz Air) ... 14 flights from other airlines are hidden here", with an "Ignore my airline filter" switch). Two columns,
> Outbound and Return, each a list of selectable flight rows (times, airline name and code, duration, price, a "bags usually
> extra" chip) with a highlighted selected row, and a total with the time between the two flights. Each row has a small purple
> "Select on site" button that opens the airline's own site.

### L. Airline-site helper (browser extension banner)
> A slim full-width banner pinned to the top of an airline's website, injected by our extension. Dark navy, white text, one line,
> with states: working ("looking for the flight list..."), success (the cheapest fare on that page is outlined in magenta),
> teaching ("Please search Tel Aviv (TLV) to Rome (FCO) on 2 Oct 2026 here once"), and error (red). It must not clash with any
> airline's header.


### M. Results rules added 26 Sept 2026 (apply to screens C, D and K)
- The **airline filter bar is sticky** at the top of the results, always visible.
- **Airline names are bold** (weight 800, at least 15px) on every flight; flight code lighter and smaller.
- **"Check on airline site" is a readable 44px button** (2px accent border, dark bold text, external-link icon, full label).
- **No single "cheapest"**: with several destinations and trip lengths show a trip-length-by-destination matrix (best total per cell, heatmap, clickable, nothing pre-selected) plus a sortable, filterable table of all trips **grouped by trip length** (a band per length with every destination under it), and the price-by-day chart coloured by destination.
See `docs/stitch/DESIGN.md`, "Results screen rules".


### N. The finished design (26-27 Sept 2026)
Stitch project **"Skyhop"** (project id `11409652542807754071`). Final screens: search ("Skyhop - Flexible Date Flight Search Workspace", with the
trip-length expert-mode states), results ("Skyhop - Flight Search Results Workspace (Grouped by Length)") and its dark version
("... (Dark Theme)"). Stitch keeps renaming the design system ("Vibrant Pulse") and re-adding a 1280px max width; the screens themselves are
full width, and the source of truth is `docs/stitch/DESIGN.md`. Implemented in the app: results screen, search form, dark mode. Mobile is not designed yet.
