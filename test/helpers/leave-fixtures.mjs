// Shared fakes for the leave days tests. Every value here is made up, and nothing in
// this file opens a connection to Microsoft or Workday.
import { once } from "node:events";
import express from "express";

export const TENANT_ID = "11111111-aaaa-4bbb-8ccc-222222222222";
export const CLIENT_ID = "33333333-dddd-4eee-8fff-444444444444";
export const EMPLOYEE = "ava.employee@northstar.example";
export const OTHER_EMPLOYEE = "noah.colleague@northstar.example";
export const NOW = Date.parse("2026-11-27T12:00:00Z");
export const TODAY = "2026-11-27";

export const SIGN_IN_ENV = Object.freeze({
  ENTRA_TENANT_ID: TENANT_ID,
  ENTRA_CLIENT_ID: CLIENT_ID,
  ENTRA_CLIENT_SECRET: "fake-entra-client-secret-Zq81",
  ENTRA_REDIRECT_URI: "https://portal.northstar.example/api/auth/callback"
});

export const WORKDAY_ENV = Object.freeze({
  WORKDAY_TOKEN_URL: "https://workday.example.test/ccx/oauth2/acme/token",
  WORKDAY_CLIENT_ID: "fake-workday-client-id",
  WORKDAY_CLIENT_SECRET: "fake-workday-client-secret-Kp47",
  WORKDAY_REFRESH_TOKEN: "fake-workday-refresh-token-Mn92",
  WORKDAY_REPORT_URL: "https://workday.example.test/ccx/service/customreport2/acme/owner/Leave_Balance"
});

export const FULL_ENV = Object.freeze({ ...SIGN_IN_ENV, ...WORKDAY_ENV });

export function claimsFor(upn, overrides = {}) {
  return { tid: TENANT_ID, aud: CLIENT_ID, upn, ...overrides };
}

/**
 * Stands in for the MSAL confidential client. It records every request, and the
 * claims (or error) it answers with are set by the test.
 */
export function fakeSignInClient() {
  const fake = {
    claims: claimsFor(EMPLOYEE),
    authUrlError: null,
    exchangeError: null,
    settings: [],
    authUrlRequests: [],
    exchanges: [],
    create(settings) {
      fake.settings.push(settings);
      return {
        async getAuthCodeUrl(request) {
          fake.authUrlRequests.push(request);
          if (fake.authUrlError) throw fake.authUrlError;
          const url = new URL("https://login.fake.test/authorize");
          url.searchParams.set("state", request.state);
          return url.toString();
        },
        async acquireTokenByCode(request, payload) {
          fake.exchanges.push({ request, payload });
          if (fake.exchangeError) throw fake.exchangeError;
          return { idTokenClaims: fake.claims, accessToken: "fake-entra-access-token", idToken: "fake-entra-id-token" };
        }
      };
    }
  };
  return fake;
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Stands in for Workday's token endpoint and custom report. `balances` maps a work
 * email to the report rows returned for it.
 */
export function fakeWorkday({ balances = { [EMPLOYEE]: [{ daysLeft: 13.625 }] } } = {}) {
  const fake = {
    balances,
    calls: [],
    token: () => jsonResponse({ access_token: "fake-workday-access-token-Tr55", token_type: "Bearer" }),
    report: (url) => jsonResponse({ Report_Entry: fake.balances[url.searchParams.get("workEmail")] ?? [] }),
    async fetch(url, options = {}) {
      const target = new URL(url);
      fake.calls.push({ url: target, options });
      if (target.href === WORKDAY_ENV.WORKDAY_TOKEN_URL) return fake.token(target, options);
      if (`${target.origin}${target.pathname}` === WORKDAY_ENV.WORKDAY_REPORT_URL) return fake.report(target, options);
      throw new Error("Unexpected outbound address in a test");
    }
  };
  return fake;
}

/** Serves a router on a free loopback port. The caller closes it. */
export async function serve(router) {
  const app = express();
  app.use(router);
  app.get("/api/health", (_request, response) => response.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    })
  };
}

/** Parses Set-Cookie headers into { name: { value, attributes } }. */
export function setCookies(response) {
  const cookies = {};
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(";").map((part) => part.trim());
    const separator = pair.indexOf("=");
    cookies[pair.slice(0, separator)] = {
      value: pair.slice(separator + 1),
      attributes: Object.fromEntries(attributes.map((attribute) => {
        const [key, value = true] = attribute.split("=");
        return [key.toLowerCase(), value];
      }))
    };
  }
  return cookies;
}

// Captured before any test replaces the global, so test requests always reach loopback.
const loopbackFetch = globalThis.fetch;

export function get(base, path, { cookies = {}, headers = {} } = {}) {
  const cookie = Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ");
  return loopbackFetch(`${base}${path}`, {
    redirect: "manual",
    headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) }
  });
}

/** Starts a sign-in as a browser would, returning what the callback needs. */
export async function startSignIn(base) {
  const response = await get(base, "/api/auth/sign-in");
  const flowCookie = setCookies(response).northstar_signin?.value;
  const location = response.headers.get("location");
  const state = new URL(location, base).searchParams.get("state");
  return { response, flowCookie, state, location };
}

export function finishSignIn(base, { flowCookie, state }, { code = "fake-auth-code-Qx12", cookies = {} } = {}) {
  const query = new URLSearchParams({ ...(code === null ? {} : { code }), ...(state === null ? {} : { state }) });
  return get(base, `/api/auth/callback?${query}`, {
    cookies: { ...cookies, ...(flowCookie ? { northstar_signin: flowCookie } : {}) }
  });
}

/** A whole successful sign-in. Returns the session cookie value. */
export async function signIn(base) {
  const response = await finishSignIn(base, await startSignIn(base));
  return setCookies(response).northstar_session?.value;
}

export function leaveDays(base, session, query = `?asOfDate=${TODAY}`, headers = {}) {
  return get(base, `/api/leave-days${query}`, {
    cookies: session ? { northstar_session: session } : {},
    headers
  });
}

/** Records everything written through the console while a test runs. */
export function captureConsole(t) {
  const lines = [];
  for (const method of ["log", "warn", "error", "info", "debug", "trace"]) {
    t.mock.method(console, method, (...args) => {
      lines.push(args.map((arg) => (arg instanceof Error ? `${arg.stack}` : String(arg))).join(" "));
    });
  }
  return lines;
}
