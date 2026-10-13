# Skyhop Worker

A small Cloudflare Worker that holds Skyhop's API keys. Skyhop is a static page on GitHub Pages, so it cannot keep a
secret. Instead, it signs you in with Google and asks this Worker, which adds the key and calls the service for it.

| Route | What it does |
|---|---|
| `GET /health` | Shows which keys are set and whether your Google sign-in is accepted. It is open to everyone. |
| `GET /gflights?origin=TLV&dest=FCO&date=2026-11-02&currency=USD&adults=1&max_stops=1` | Runs one one-way lookup straight from Google Flights. It's free and needs no key, but Google may refuse it, so the page then asks `/serpapi`. |
| `GET /serpapi?origin=TLV&dest=ROM&date=2026-11-02&currency=USD&adults=1&max_stops=1` | Runs one one-way Google Flights lookup through SerpApi, costing one credit. |
| `POST /decide` | Asks Jev (via OpenRouter) for a typed decision. The Airline Assist extension uses it. |
| `POST /chat` | Runs one model turn for the in-app AI chat (`web/chat.js`). The model is the `CHAT_MODEL` variable. |
| `GET /links`, `POST /links` | Airline search links the desktop extension learned, so phones can open the airline's own results page. Anyone signed in reads them; only allowed accounts add them (`src/links.js`). |
| `POST /trips`, `GET /trips/:id?since=N`, `POST /trips/:id/messages`, `PATCH /trips/:id` | Shared trips: a group chat per trip, stored in a Durable Object (`src/trips.js`). |

Every route except `/health` needs one of these:

- A Google access token issued to Skyhop's OAuth client. If `ALLOWED_EMAILS` is set, the account must also be on that
  list.
- `X-App-Token: <APP_TOKEN>`, for scripts.

Any other verified Google account counts as a **guest**:
- A guest can join shared trips it has the link to.
- A guest can use `/chat`, `/gflights` and `/serpapi` only inside such a trip (the `X-Trip` header), out of that
  trip's daily allowance.
- Only allowed accounts can start trips or use `/decide`.

Shared trips and search links use SQLite-backed Durable Objects, which the Workers free plan includes. The first deploy creates them from
`wrangler.toml`, so there's nothing to set up by hand.

## One-time setup

Everything is set in GitHub (Settings → Secrets and variables → Actions); the deploy copies it to the Worker.

1. **Cloudflare token.** In the Cloudflare dashboard, go to My Profile → API Tokens → Create Token, and pick the "Edit
   Cloudflare Workers" template. Add it as the **secret** `CLOUDFLARE_API_TOKEN`, and your account id (shown on the
   Workers overview page) as the **variable** `CLOUDFLARE_ACCOUNT_ID`.
2. **Google sign-in.** Reuse the OAuth client that mymaps-ai uses (Google Cloud Console → APIs & Services →
   Credentials). Its *Authorized JavaScript origins* must include `https://alon24.github.io`. Add its client ID as the
   **variable** `SKYHOP_GOOGLE_CLIENT_ID`. For "Save to Drive" and "Map it", also enable the **Google Drive API** in that
   project (APIs & Services → Library). It must be the *same* client as mymaps-ai: Google only lets an app see the
   Drive files its own client made, so "Map it" can add to your existing MyMaps AI maps only then. If the consent screen is in testing mode, add your account as a test user.
3. **Who may spend the keys.** The **variable** `SKYHOP_ALLOWED_EMAILS` (comma separated). Without it, any Google
   account can spend your SerpApi and OpenRouter credits.
4. **Keys** (optional): the **secrets** `OPENROUTER_API_KEY` (the AI chat and Jev) and `SERPAPI_API_KEY` (backup fares
   when Google refuses the Worker).
5. **Deploy.** Re-run the "Test and deploy to Pages" workflow (or push to `main`). It publishes the Worker at
   `https://skyhop-worker.<your-subdomain>.workers.dev` and gives the site that address (set the variable
   `SKYHOP_WORKER_URL` only to use a different one). The site now shows a **Sign in** button. Once you're signed in,
   searches use real fares and the badge says LIVE.

Deploys keep what you set in the dashboard, because `wrangler.toml` has `keep_vars = true`.

## Developing

```bash
node --test                      # unit tests (also run by pytest: tests/test_worker.py)
npx wrangler@4 dev --var SERPAPI_API_KEY:... --var APP_TOKEN:dev
curl -H 'X-App-Token: dev' 'localhost:8787/serpapi?origin=TLV&dest=ROM&date=2026-11-02'
```
