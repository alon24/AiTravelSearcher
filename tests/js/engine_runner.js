// Runs the browser engine (src/flightagent/web/local/) for tests/test_browser_parity.py: reads one JSON job on stdin,
// prints the result as JSON. Jobs: {op: "search" | "estimate", request}, {op: "one_way", args},
// {op: "analyse", legs, currency}, {op: "pick", rows, name} (airline site), {op: "request", request} (validation only),
// {op: "serpapi_parse", data, args} (a SerpApi answer -> offers).
"use strict";
const path = require("path"), fs = require("fs");
const dir = path.join(__dirname, "..", "..", "src", "flightagent", "web", "local");
for (const f of ["models", "rng", "mock", "geo", "itinerary", "polling", "engine", "db", "sites", "serpapi", "backend"]) require(path.join(dir, `${f}.js`));
const L = globalThis.SkyhopLocal;
L.geo.setZones(JSON.parse(fs.readFileSync(path.join(dir, "..", "..", "data", "airport_tz.json"), "utf8")));

async function run(job) {
  switch (job.op) {
    case "search": return new L.engine.Engine(L.mock).search(L.models.searchRequest(job.request));
    case "estimate": return new L.engine.Engine(L.mock).estimate(L.models.searchRequest(job.request));
    case "one_way": return L.mock.oneWay(...job.args);
    case "analyse": return L.itinerary.analyse(job.legs, job.currency);
    case "pick": return L.sites.pick(job.rows, job.name);
    case "serpapi_parse": return L.serpapi.parse(job.data, ...job.args);
    case "request":
      try { return L.models.searchRequest(job.request); } catch (e) { return { error: e.message }; }
    default: throw new Error(`unknown op ${job.op}`);
  }
}

let input = "";
process.stdin.on("data", c => { input += c; });
process.stdin.on("end", async () => process.stdout.write(JSON.stringify(await run(JSON.parse(input)))));
