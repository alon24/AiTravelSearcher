// An airline's website from Wikidata's rows (local/sites.js pick): the label must share a word with the airline's
// name, then rows found by IATA code beat rows found by name, then the closest label. Never a guess.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { L } = require("./skyhop");

const site = (label, url, byCode) => ({ aLabel: { value: label }, site: { value: url }, byCode: { value: String(byCode) } });

const CASES = [
  ["the name decides over a code that belonged to another airline", [site("Animawings", "https://animawings.com/", 0), site("Aero Contractors", "https://flyaero.com/", 1)], "AnimaWings", "https://animawings.com/"],
  ["a row found by code beats one found by name", [site("Wizz Air", "https://wizzair.com/", 0), site("Wizz Air Hungary", "https://wizzair.com/hu", 1)], "Wizz Air Hungary", "https://wizzair.com/hu"],
  ["among rows found by code, the closest label wins", [site("Air Malta", "https://airmalta.com/", 1), site("KM Malta Airlines", "https://kmmaltairlines.com/", 1)], "KM Malta Airlines", "https://kmmaltairlines.com/"],
  ["no name: the code's row is taken", [site("Some Airline", "https://x.example/", 1)], "", "https://x.example/"],
  ["a row without a website is skipped", [site("Lufthansa", "https://lufthansa.com/", 1), { aLabel: { value: "Lufthansa" } }], "Air Lufthansa", "https://lufthansa.com/"],
  ["sharing only a filler word like Air is no match", [site("Air France", "https://airfrance.com/", 1)], "Air India", null],
];
for (const [name, rows, airline, want] of CASES) test(`airline website: ${name}`, () => assert.equal(L.sites.pick(rows, airline), want));
