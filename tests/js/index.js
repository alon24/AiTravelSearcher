// `node --test tests/js/` loads this file (a directory resolves to its index.js): it runs every *.test.js here.
// Each file also runs alone: node --test tests/js/engine.test.js
"use strict";
for (const f of require("fs").readdirSync(__dirname).filter(f => f.endsWith(".test.js")).sort()) require(`./${f}`);
