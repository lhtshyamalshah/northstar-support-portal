# Northstar Support Portal !!

A React/Vite customer-support portal with a Node/Express API and an open order dashboard at `/admin`.

## Run locally

1. Install Node.js 20 or later.
2. Copy `.env.example` to `.env` and add an OpenAI API key.
3. Install dependencies and start the Vite client plus Express API:

   ```powershell
   npm install
   npm run dev
   ```

4. Open `http://localhost:5173`; the open admin dashboard is at `http://localhost:5173/admin`.

For a production-style local run, use `npm run build`, then set `NODE_ENV=production` and run `npm start`. Express will serve the compiled `dist` client and the API on port 3000.

The server reads `OPENAI_API_KEY` only on the backend. If the key is absent, the portal uses a local fallback for seeded order and policy flows; adding the key enables the two OpenAI agents.

## Implementation notes

- The React client is in `src/main.jsx`; Vite proxies `/api` requests to Express during development.
- The ten sample orders live in `server.mjs` only and reset whenever the process restarts.
- Order lookups use an OpenAI function tool that reads only the in-memory order collection. Unknown order IDs are rejected server-side before a model response, preventing invented order details.
- Messages about refunds, duplicate charges, and invoices are routed to a separate billing-specialist prompt. All other messages go to the general support prompt.
- Set `OPENAI_MODEL` if your OpenAI project uses a different supported text model.
