> **Imported codebase.** Architecture described as-built from the existing source, not generated from a plan.

# Northstar Support Portal — Architecture

A customer-support portal for a fictional online store ("Northstar"). A React/Vite
single-page client talks to a Node/Express API that runs two OpenAI-backed support
agents behind a keyword router, plus an internal order-desk dashboard.

## Stack

- **Language:** JavaScript (ES modules, `.mjs` / `.jsx`), no TypeScript.
- **Frontend:** React 19 + Vite 7 (`@vitejs/plugin-react`).
- **Backend:** Node + Express 5.
- **AI:** OpenAI SDK v6 (`openai`), Responses API with function tool-calling.
- **Package manager:** npm (single `package.json`, `package-lock.json` present).

## Services

This is a **single repository that runs as two processes** in development, sharing
one `package.json` and one `node_modules`:

1. **backend** — `server.mjs`, an Express API on `process.env.PORT` (default 3000).
   Express binds all interfaces by default. Endpoints:
   - `GET /api/health` — `{ ok, aiEnabled, model }`.
   - `GET /api/orders` — the ten seeded in-memory orders (for the admin desk).
   - `POST /api/chat` — `{ message, history, activeAgent }` → `{ agent, handoff, reply, source }`.
   In `NODE_ENV=production` the same process also serves the built `dist/` client and
   SPA-falls-back non-`/api` routes to `index.html` (single-container production model).

2. **frontend** — Vite dev server (`vite`) serving `index.html` + `src/main.jsx` on
   port 5173. It proxies `/api` to the backend (currently hardcoded
   `http://localhost:3000`). Two client-side routes decided by `window.location.pathname`:
   `/` (Nova support chat) and `/admin` (read-only order desk table). Styling is a
   single static `public/styles.css`.

`npm run dev` runs both via `concurrently`; `npm run dev:server` / `npm run dev:client`
run them individually.

## Request & data flow

- Browser → same-origin `/api/*` on the Vite dev server → Vite proxy → Express.
- **Chat:** `POST /api/chat` → `askAgent()`. A regex router (`billingPattern`) decides
  between the **support** agent (Nova) and the **billing** agent (Sage), with a one-time
  `handoff` flag when support hands to billing. Order IDs are extracted from the message
  and prior user turns; any unknown ID is rejected **locally before the model is called**,
  so the model can never invent order details. The chosen agent runs against
  `openai.responses.create` with a single `lookup_order` function tool, looping up to 3
  turns to satisfy tool calls. Tool output is only returned for order IDs the customer
  actually supplied.
- **Fallback:** if `OPENAI_API_KEY` is unset, `askAgent` returns a deterministic
  `localReply(...)` (`source: "demo"`) so the UI works without a key.
- **Admin:** `GET /api/orders` renders the seeded order table.
- **State:** orders are an in-memory array in `server.mjs`; there is **no database**.
  State resets on restart. No auth — the admin desk is intentionally open.

## External dependencies

- **OpenAI API** (Responses API) — the only external dependency. Optional: absent key →
  demo fallback.

## Environment variables

| Variable | Read in | Required | Purpose |
|---|---|---|---|
| `PORT` | `server.mjs` | platform-injected | Express bind port |
| `OPENAI_API_KEY` | `server.mjs` | for live AI | enables the OpenAI agents; unset → demo fallback |
| `OPENAI_MODEL` | `server.mjs` | no (default `gpt-4.1-mini`) | model id |
| `NODE_ENV` | `server.mjs` | no | `production` → Express serves built client |
| `BACKEND_1_URL` | `vite.config.js` (added for platform) | preview only | proxy target for `/api` |

`server.mjs` also has a dependency-free `loadEnvFile()` that reads a local `.env` but
never overrides an already-set process-env var, so platform-injected values win.

## Tests

None present in the repository.
