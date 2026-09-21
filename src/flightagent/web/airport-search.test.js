// Run: node src/flightagent/web/airport-search.test.js   (from the repo root)
const fs = require("fs"), path = require("path"), assert = require("assert");
const S = require("./airport-search.js");
const list = S.prepare(JSON.parse(fs.readFileSync(path.join(__dirname, "airports.json"), "utf8")));
const top = (q, n = 3) => S.search(list, q, n).map(r => r.a.code);
// [query, codes that must appear within the first N results]
const cases = [
  ["buka", ["OTP", "BUH"], 3], ["bucarest", ["OTP", "BUH"], 2], ["bukurest", ["OTP", "BUH"], 3], ["bucuresti", ["OTP", "BUH"], 2],
  ["praga", ["PRG"], 1], ["prage", ["PRG"], 2], ["wien", ["VIE"], 1], ["munchen", ["MUC"], 1], ["muenchen", ["MUC"], 3],
  ["barselona", ["BCN"], 1], ["amstrdam", ["AMS"], 1], ["amsterdm", ["AMS"], 1], ["budapesht", ["BUD"], 2], ["lisbone", ["LIS"], 2],
  ["athenz", ["ATH"], 2], ["istambul", ["IST"], 3], ["londn", ["LON", "LHR"], 3], ["lodon", ["LON", "LHR"], 3], ["parris", ["PAR", "CDG"], 3],
  ["roma", ["ROM", "FCO"], 2], ["rom", ["ROM"], 1], ["tlv", ["TLV"], 1], ["tel aviv", ["TLV"], 1], ["gurion", ["TLV"], 1],
  ["heathrow", ["LHR"], 1], ["charles de gaulle", ["CDG"], 1], ["larnaka", ["LCA"], 1], ["paphos", ["PFO"], 1], ["dubay", ["DXB"], 2],
  ["new yrok", ["NYC", "JFK"], 3], ["ניו יורק", ["NYC", "JFK"], 3], ["רומא", ["ROM"], 1], ["פריז", ["PAR"], 3], ["בוקרשט", ["OTP", "BUH"], 2],
  ["par", ["PAR", "CDG"], 2], ["lond", ["LON", "LHR"], 2], ["bangkok", ["BKK"], 1], ["bkk", ["BKK"], 1],
];
let failed = 0;
for (const [q, want, n] of cases) {
  const got = top(q, n);
  const ok = want.some(w => got.includes(w));
  if (!ok) { failed++; console.log(`FAIL ${q.padEnd(18)} wanted one of ${want} in top ${n}, got ${top(q, 5)}`); }
}
// speed: a keystroke must stay well under a frame budget on 6k airports
const t0 = process.hrtime.bigint(); for (let i = 0; i < 20; i++) S.search(list, "bukarst"); const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
console.log(`${cases.length - failed}/${cases.length} queries ok; ${ms.toFixed(1)} ms per search`);
assert.ok(ms < 60, "search too slow");
assert.strictEqual(failed, 0);
