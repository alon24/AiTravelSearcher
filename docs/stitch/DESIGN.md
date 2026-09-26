# Skyhop design system

For Google Stitch (import as DESIGN.md / design system). Skyhop is a flexible-date flight search tool: young, fresh, playful
but trustworthy. Money and dates must be instantly scannable. One primary action per screen.

## Colour

| Role | Light | Dark |
|---|---|---|
| Background | `#f6f4ff` | `#0d0c1b` |
| Card | `#ffffff` | `#171532` |
| Ink (text) | `#1a1633` | `#f5f3ff` |
| Secondary text | `#57537a` | `#bdb9dc` |
| Hairlines | `#e9e6f7` | `#2b2850` |
| Accent (solid) | `#6d4aff` | `#9a83ff` |

- **Accent gradient** (main call to action and the "cheapest" highlight only, used sparingly): `#6d4aff` -> `#c44cff` -> `#ff4f9a`, 120deg.
- **Status:** warning amber (`#fff3d6` background, `#8a4b00` text), success green, error red. Always paired with an icon and text, never colour alone.
- **Chart series** (data marks only, in this order): `#2a78d6`, `#eb6834`, `#1baf7a`, `#eda100`, `#e87ba4`, `#008300`, `#4a3aa7`, `#e34948`.
  Dark mode: `#3987e5`, `#d95926`, `#199e70`, `#c98500`, `#d55181`, `#008300`, `#9085e9`, `#e66767`.

## Typography

Plus Jakarta Sans, weights 400-800. Headings 800 with tight tracking. Prices bold. Labels are small uppercase (12px, 0.05em).
Numbers in prices and times use tabular figures.

## Shape and spacing

Radius 14px on inputs, 20px on cards, pill chips and switches. Inputs 48px tall. Buttons at least 44px. Soft glow shadows, generous
whitespace, 8px spacing grid.

## Components

- **Chips:** removable airport chips ("TLV - Tel Aviv"), airline chips with an ONLY action, filter chips ("Active filters").
- **Segmented control:** two or three options, selected one filled with the gradient (Nights / Days, Exactly / Between, Stops).
- **Switch:** 40x24 pill, accent when on (Expert mode, Same airline both ways).
- **Stepper:** minus, number, plus in one 48px field (trip length).
- **Badges:** small pills in the header: LIVE (green), ASSIST ON (green) or ASSIST OFF (amber), the decision model (Laya / Jev).
- **Cards:** trip card (dates, route, airlines, price, "cheapest" tag), flight row (times, airline, flight code, duration, price).
- **Toast:** bottom, 3 seconds, one line.

## Rules

- Money is whole units with a symbol (`$141`), never cents. Dates `Sat 17 Oct`. Times 24-hour `19:40`. Durations `3h 50m`.
- WCAG AA contrast, visible focus rings, a label on every field, the chart also available as a table.
- **Use the full screen (most important):** Skyhop is a work tool on a laptop or desktop, so it fills the whole browser window. No centred narrow column and no max-width container: a fixed left sidebar (about 300px) and a main area that stretches to the right edge with fluid padding, using multi-column grids (outbound and return side by side, full-width chart and tables). Design for 1440-2560px first, keep 1280px laptops useful.
- Light and dark themes. Mobile (390px) comes LATER; when it does, the sidebar
  becomes a slide-in drawer.

## Results screen rules

1. **The airline filter bar is sticky**: pinned to the top of the results, always visible while scrolling, solid background and a soft shadow. One chip per airline in the results ("Wizz Air | ONLY"), excluded airlines struck through and dimmed, "Show all" and "Filter on: 1 of 5 airlines used" on the right.
2. **Airline names are bold** on every flight row and trip: weight 800, ink colour, at least 15px, right after the times; the flight code (W46044) is lighter and smaller.
3. **"Check on airline site" is a real, readable button**: at least 44px tall, 14-15px bold text, white with a 2px accent border and dark text (or solid accent with white text), external-link icon, labelled in full ("Check on Wizz Air site"). Never small grey link text.
4. **No single "cheapest" answer.** One search can cover several destinations and several trip lengths (4, 5 or 6 nights to Rome, Paris and London), so results are consumed as: (a) a matrix, destination by trip length, each cell the best total for that combination (heatmap, click a cell to filter); (b) a full-width sortable table of all trips, **grouped by trip length by default**: a band per length ("4 nights · from $203", "5 nights · from $188", "6 nights · from $231") with every destination listed under it, sorted by price, cheapest of each band in bold accent; filters are multi-select and start on "All destinations" / "All lengths" (never pre-filtered to one combination), group-by (none / destination / length), "Best per destination and length" vs "All trips", sort (price, best value, fewest stops, shortest travel time), a nonstop switch and a result count; the matrix is oriented the same way (rows = trip lengths, columns = destinations); (c) the price-by-day chart coloured by destination.
   Table layout: fixed, never wider than its card (7 columns: destination, dates, total, outbound, return, trip info, action); every row keeps its readable "Check on airline site" button.
5. **Do not invent** navigation, features, marketing claims or advice the app does not have. The sidebar has only the logo, "+ New search" and "Past searches".
