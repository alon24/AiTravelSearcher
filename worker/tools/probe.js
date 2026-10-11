/* Ten one-way lookups a month ahead through the Worker's own Google Flights code (src/gflights.js), the path the
   Pages site uses for free fares. Run daily by .github/workflows/gflights-probe.yml so a change on Google's side
   shows up as an issue before someone searching sees it. Exits 1 when fewer than 8 lookups return priced flights. */
import { gflights } from "../src/gflights.js";

const ROUTES = [["TLV", "FCO"], ["TLV", "ATH"], ["LHR", "JFK"], ["BUD", "TLV"], ["CDG", "BCN"]];
const json = body => new Response(JSON.stringify(body));
const error = (message, status) => new Response(JSON.stringify({ error: message }), { status });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ok = 0;
for (const [i, [o, d]] of [...ROUTES, ...ROUTES].entries()) {
  const day = new Date(Date.now() + (30 + i) * 864e5).toISOString().slice(0, 10);
  const r = await gflights(new URL(`https://w/gflights?origin=${o}&dest=${d}&date=${day}&currency=USD`), { json, error }, sleep);
  const body = await r.json();
  const prices = (body.groups || []).map(g => g?.[1]?.[0]?.[1]).filter(p => typeof p === "number");
  if (r.ok && prices.length) { ok++; console.log(`OK   ${o}->${d} ${day}: ${body.groups.length} flights, cheapest ${Math.min(...prices)}`); }
  else console.log(`FAIL ${o}->${d} ${day}: ${body.error || `${(body.groups || []).length} flights, none priced`}`);
}
console.log(`${ok}/10 lookups returned priced flights`);
process.exit(ok >= 8 ? 0 : 1);
