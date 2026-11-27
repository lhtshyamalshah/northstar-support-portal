# Northstar Support Portal !!

A React/Vite customer-support portal with a Node/Express API and an open order dashboard at `/admin`.

## Run with Docker

You need Docker with Docker Compose.

1. Copy `.env.example` to `.env` and fill in the settings you need. For a run without ZBrain Governance, set `ZBRAIN_GOVERNANCE=false`; with it on, the app refuses to start unless the governance settings are present.
2. Run `./run.sh` (or `run.cmd` on Windows).
3. Open `http://localhost:3000`.

The container serves plain HTTP. For anyone other than yourself on `localhost`, put it behind HTTPS, or the leave days sign-in will not work.

## Run locally

1. Install Node.js 20 or later.
2. Copy `.env.example` to `.env` and add an OpenAI API key.
3. Install dependencies and start the Vite client plus Express API:

   ```powershell
   npm run build:sdk
   npm install --install-links
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

## ZBrain: leave days page

`/leave` shows a signed-in employee their annual leave days left, and nothing else. The support page links to it. The server code is in `leave.mjs` and the page in `src/LeavePage.jsx`. It uses no AI.

### Before a first local run

The bundled governance package must be built before the app's own dependencies are installed, and every install needs `--install-links` (the lockfile packs that package rather than linking it):

```powershell
npm run build:sdk
npm install --install-links
```

### Microsoft Entra ID setup

1. Register a web app in your tenant and create a client secret. Note when the secret expires.
2. Add the redirect address `https://<your address>/api/auth/callback`. For local development, use `http://localhost:5173/api/auth/callback`.
3. Add the `upn` optional claim to the ID token. Without it every sign-in is refused. The sign-in name must match the employee's Workday work email.

### Workday setup

1. Build a custom report that Workday can return as JSON:
   - It takes two inputs, `workEmail` and `asOfDate` (`YYYY-MM-DD`).
   - It returns only the annual leave plan balance, in a column named `daysLeft`, with one row for each worker record that has that work email.
2. Create an API client with a refresh token for a system account that is limited to leave balances.

The names `workEmail`, `asOfDate` and `daysLeft` were chosen during the build. Confirm with your Workday team that the report and its date input accept them. They are set in `REPORT_FIELDS` in `leave.mjs`.

### Settings

| Variable | Value |
| --- | --- |
| `ENTRA_TENANT_ID` | Directory (tenant) ID, not a domain name |
| `ENTRA_CLIENT_ID` | Application (client) ID |
| `ENTRA_CLIENT_SECRET` | Client secret |
| `ENTRA_REDIRECT_URI` | The registered redirect address |
| `WORKDAY_TOKEN_URL` | Token address (`https` only) |
| `WORKDAY_CLIENT_ID` | API client ID |
| `WORKDAY_CLIENT_SECRET` | API client secret |
| `WORKDAY_REFRESH_TOKEN` | The system account's refresh token |
| `WORKDAY_REPORT_URL` | Report address (`https` only) |

Without these the app still starts, and only the leave days page is unavailable.

### How it behaves

- A number appears only when the report returns exactly one balance. Every other case shows "Your leave days can’t be shown right now."
- The date is the employee's local date, sent by the browser. Dates more than one day from the server's UTC date are refused.
- Sign-ins last 8 hours and are kept in server memory. A restart signs everyone out, so run one copy of the app.
- There is no sign-out. On a shared computer, close the browser after use; a browser that restores its session may keep the sign-in.
- Logs record whether each sign-in and lookup succeeded, with no names, emails or leave numbers.

### Tests

`npm test` uses stand-ins for Microsoft, Workday, OpenAI and ZBrain Governance. A real sign-in and a real Workday report have not been tested.
