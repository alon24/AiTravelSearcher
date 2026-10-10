# Skyhop for Android

The Skyhop site (`https://alon24.github.io/AiTravelSearcher/`) in an app, with the airline's own site as a second tab,
so **Select on site** can have Jev find your flight there as the desktop Airline Assist extension does.

- **Install:** open [skyhop.apk](https://github.com/alon24/AiTravelSearcher/releases/download/android-latest/skyhop.apk)
  on the phone. Android asks once to allow installs from your browser.
- **Sign in:** **Sign in** opens your phone's browser, because Google doesn't allow signing in inside apps. Sign in
  there and tap **Back to the Skyhop app**. The sign-in lasts about an hour, as on the site.
- **Select on site** opens the airline's results in the **Airline site** tab, and a banner at the top shows what Jev
  found. The cheapest fare of your flight is outlined, but nothing is pressed: you choose and pay there.

How it works: docs/DESIGN.md, "The Android app". Build: `python3 tools/build_android.py`, then
`gradle -p android assembleRelease` (needs the Android SDK; CI does this in `.github/workflows/android.yml`).
