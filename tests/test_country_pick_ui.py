"""Typing a country in a destination field: its airports with scheduled flights come first (Lisbon and Madeira were
missing for "portugal", 2026-10-10), and one pick adds its main airports. Data: tools/build_airports.py."""
import pytest

pytest.importorskip("playwright.sync_api")


def _type(page, text):
    page.fill("#to-in", text)
    page.wait_for_selector("#ac-to .ac-list li[role=option]")


def test_a_country_lists_its_real_airports_first(page):
    _type(page, "portugal")
    codes = page.locator("#ac-to .ac-list li[role=option] .ac-code").all_inner_texts()
    assert codes[0] == "🌍"
    assert {"LIS", "OPO", "FAO", "FNC"} <= set(codes[1:6]), codes
    assert not {"AVR", "QLR"} & set(codes), "air bases with no scheduled flights aren't offered"


def test_one_pick_adds_the_countrys_main_airports(page):
    _type(page, "portugal")
    country = page.locator("#ac-to .ac-country")
    assert country.locator(".ac-city").inner_text() == "Portugal: all 5 main airports"
    country.dispatch_event("mousedown")
    chips = page.locator("#ac-to .chip").all_inner_texts()
    assert sorted(c.split(" ·")[0] for c in chips) == ["FAO", "FNC", "LIS", "OPO", "PDL"]


def test_a_country_that_doesnt_fit_says_how_many_were_added(page):
    _type(page, "spain")
    page.locator("#ac-to .ac-country").dispatch_event("mousedown")
    _type(page, "portugal")
    page.locator("#ac-to .ac-country").dispatch_event("mousedown")
    page.wait_for_selector("text=Added 0 of 5 airports: at most 8 fit here. Remove some to add the rest.")
    assert page.locator("#ac-to .chip").count() == 8
