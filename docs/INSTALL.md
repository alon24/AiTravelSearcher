# Install Skyhop on another computer

Two parts: the **Skyhop server** (runs in Docker, opens at `http://localhost:8765`) and the **Chrome extension**
(*Skyhop Airline Assist*, lets a flight open the airline's own site with that flight selected). Nothing is installed
system-wide: the server lives in one Docker container, the extension in your browser.

## What you need

| | Windows | macOS | Linux |
|---|---|---|---|
| Docker | Docker Desktop | Docker Desktop | Docker Engine + compose plugin |
| Git | Git for Windows | `git` (Xcode tools) | `git` |
| Browser | Chrome, Edge or Brave (any Chromium browser) | same | same |

You also need access to the repository (it is private): sign in to GitHub with `gh auth login`, or use a personal
access token / SSH key for `alon24/AiTravelSearcher`.

## 1. Get the code

```
git clone https://github.com/alon24/AiTravelSearcher.git
cd AiTravelSearcher
```

## 2. Start the server

**Linux / macOS** (one command, safe to run again):

```
tools/install.sh
```

**Windows (PowerShell)**, from the project folder:

```
Copy-Item .env.example .env
docker compose up -d --build
```

Open **http://localhost:8765/**. The header shows a green **LIVE** badge when real prices are being fetched.
The default data source is a free Google Flights scraper: no account, no key.

## 3. Install the Chrome extension

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. **Load unpacked**, and choose the **`browser-extension`** folder inside the project.
4. Open the extension's **Details**, and under **Site access** choose **Automatically allow access on the following sites**.
   (Without this Chrome may block the extension on the airlines' sites.)
5. Pin the extension (puzzle-piece icon) so you can see its status number.
6. Reload `http://localhost:8765/`. The header should show **✈ ASSIST ON**.

If it says **ASSIST OFF**: the extension is disabled or needs a reload in `chrome://extensions`, then refresh the page.

## 4. Choose the decision model (only for the Assist buttons)

When a flight's "Select on site" button opens an airline's website, a small decision model finds the buttons on that page.
The **🧠 badge** in the header switches between two:

- **Jev** (easiest on a new computer): a hosted model from TypeSafe via OpenRouter. Put your key in `.env`:
  ```
  OPENROUTER_API_KEY=sk-or-...
  ```
  then run `docker compose up -d` and click the badge until it says **Jev**. It costs a fraction of a cent per airline page.
  The key stays on your computer's server and is never given to the extension.
- **Laya**: a local model that runs on your machine (free, offline). It is a separate service that is **not in this
  repository yet**, so on a new computer use Jev.

The search itself (prices, dates, mixing airlines) does not need either one.

## Optional settings (`.env`)

| Setting | What it does |
|---|---|
| `FLIGHTAGENT_PROVIDER=gflights,serpapi` | Free scraper first, SerpApi if Google blocks it. `mock` gives fake demo fares. |
| `SERPAPI_API_KEY=` | Optional, from serpapi.com (free plan: 250 lookups a month). |
| `FLIGHTAGENT_VERIFIER=serpapi` | Optional. Adds "Verify" buttons that re-check a trip's price on a second provider (must differ from the first `FLIGHTAGENT_PROVIDER`). |
| `OPENROUTER_API_KEY=` | For Jev, see above. |
| `FLIGHTAGENT_DECIDER=laya` or `jev` | Model for the server-side diagnostics (not the extension badge). |

After changing `.env`, run `docker compose up -d`. **Never commit `.env`** (it is ignored by git and holds your keys).

## Update to the latest version

```
git pull
docker compose up -d --build
```

Then in `chrome://extensions`, click the **reload** icon on Skyhop Airline Assist, and refresh `http://localhost:8765/`.
If Chrome switches the extension off after an update, turn it back on.

## Check that it works

```
docker compose ps              # flightagent should be "running"
curl http://localhost:8765/health
docker compose logs flightagent
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `port is already allocated` (8765) | Something else uses port 8765. Stop it, or change `127.0.0.1:8765:8765` in `docker-compose.yml` (and the same port in the extension's `manifest.json` `content_scripts` matches). |
| Page says **ASSIST OFF** | Extension disabled or not loaded: `chrome://extensions`, enable it, reload it, refresh the page. |
| Assist button opens the airline but nothing is outlined | Turn on Site access (step 3.4). Make sure a decision model is chosen and reachable: the 🧠 badge turns amber "not running" if it isn't. |
| Prices say demo data | `FLIGHTAGENT_PROVIDER` is `mock` in `.env`. Set it to `gflights,serpapi`. |
| Google blocks the scraper | Add a `SERPAPI_API_KEY`; the app falls back to it automatically. |

## Uninstall

```
docker compose down -v      # removes the container and its price cache
```

Then remove the extension in `chrome://extensions` and delete the project folder.

## Safety notes

- The server only listens on `127.0.0.1` (this computer), not on your network.
- The extension needs access to the airline sites it drives and to `localhost:8765`. It never sees your payment or passenger
  details: it stops at the fare selection screen.
- Keep `.env` private. Anyone with your OpenRouter or SerpApi key can spend your credit.
