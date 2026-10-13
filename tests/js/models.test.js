// The search request (local/models.js): defaults, normalising and validation, how travellers map to Google's
// passenger types, and when fetched fares go stale (local/polling.js).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { L, M, req } = require("./skyhop");
const { unpricedInterval, fareTtl, nextCheckTime } = L.polling;

test("travellers' ages map to Google's adult, child and lap-infant passengers", () => {
  const r = req({ adults: 2, children_ages: [0, 5, 11, 12, 16] });
  assert.deepEqual(M.pax(r), { adults: 4, children: 2, infants: 1 });
  assert.equal(M.paxLabel(r), "2 adults, children aged 0, 5, 11, 12, 16");
  for (const bad of [{ children_ages: [18] }, { children_ages: [-1] }, { adults: 1, children_ages: [0, 1] },
    { adults: 5, children_ages: [3, 3, 3, 3, 3] }, { adults: 0 }]) {
    assert.throws(() => req(bad), M.ValidationError, JSON.stringify(bad));
  }
  assert.throws(() => req({ adults: 1, children_ages: [0, 1] }), { message: "Each infant under 2 needs their own adult (one lap infant per adult)" });
});

const BASE = { origin: "TLV", window_start: "2026-11-02", window_end: "2026-11-12", min_nights: 3, max_nights: 5 };

test("a request is filled with defaults and its codes are cleaned up", () => {
  const r = M.searchRequest({ ...BASE, destinations: ["fco"], airlines_include: ["w6", "w6", ""], self_transfer_hubs: ["ist"], allow_connections: false });
  assert.deepEqual(r, { ...BASE, destinations: ["FCO"], return_airports: [], open_jaw: true, connect_destinations: false,
    allow_connections: false, max_stops_per_leg: 0, min_layover_min: 90, max_layover_min: 4320, max_travel_min_per_direction: null,
    allow_mixed_airlines: true, allow_self_transfer: false, self_transfer_hubs: ["IST"], self_transfer_buffer_min: 240, min_nights_per_stop: 1,
    stale_ok: false, refresh_unpriced: false, airlines_include: ["W6"], airlines_exclude: [], carry_on_bags: 0, checked_bags: 0, adults: 1,
    children_ages: [], currency: "USD", value_of_time_per_hour: 10, self_transfer_penalty: 40, top_n: 5, max_api_calls: 400 });
});

const INVALID = {
  "no destination": [{ destinations: [] }, /destinations: List should have at least 1 item/],
  "a window that ends where it starts": [{ window_end: "2026-11-02" }, /window_end must be after window_start/],
  "fewer max than min nights": [{ max_nights: 2 }, /max_nights must be >= min_nights/],
  "no adult": [{ adults: 0 }, /adults: Input should be greater than or equal to 1/],
  "two lap infants for one adult": [{ adults: 1, children_ages: [0, 1] }, /one lap infant per adult/],
  "ten travellers": [{ adults: 5, children_ages: [3, 4, 5, 6, 7] }, /At most 9 travellers/],
  "an 18-year-old child": [{ children_ages: [18] }, /children_ages must be between 0 and 17/],
  "four checked bags": [{ checked_bags: 4 }, /checked_bags: Input should be less than or equal to 3/],
};
for (const [name, [body, message]] of Object.entries(INVALID)) {
  test(`a request is refused: ${name}`, () => {
    assert.throws(() => M.searchRequest({ ...BASE, destinations: ["FCO"], ...body }), err => err instanceof M.ValidationError && message.test(err.message));
  });
}

test("fares near departure and flights without a price are asked about again sooner", () => {
  assert.deepEqual([unpricedInterval(3), unpricedInterval(30), unpricedInterval(200)], [900, 3600, 10800]);
  assert.deepEqual([fareTtl(1, 6 * 3600), fareTtl(10, 6 * 3600), fareTtl(90, 6 * 3600)], [3600, 3 * 3600, 6 * 3600]);
  const soon = [M.addDays(M.today(), 3)];
  assert.equal(nextCheckTime(soon, 0, 1000), 1900);                    // 15 min
  assert.equal(nextCheckTime(soon, 4, 1000), 1000 + 1800);             // backs off after 4 fruitless rechecks
  assert.equal(nextCheckTime(soon, 99, 1000), 1000 + 6 * 3600);        // capped at 6 hours
  assert.equal(nextCheckTime([M.addDays(M.today(), -1)], 0, 1000), null);
  assert.equal(nextCheckTime([], 0, 1000), null);
});
