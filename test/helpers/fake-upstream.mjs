// A fake transport for Microsoft Entra ID and Workday, so the real sign-in library can
// run offline. It answers like the real services where the app depends on them, and
// refuses every other address that is not loopback.
import { createHash } from "node:crypto";
import { CLIENT_ID, EMPLOYEE, SIGN_IN_ENV, TENANT_ID, WORKDAY_ENV, jsonResponse } from "./leave-fixtures.mjs";

const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}`;

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * Plays the employee signing in at Microsoft: reads the authorization address and
 * returns the callback path the browser would be sent to. The code carries what the
 * token endpoint must later bind to it.
 */
export function approveSignIn(authorizeAddress, { upn = EMPLOYEE, claims = {} } = {}) {
  const query = new URL(authorizeAddress).searchParams;
  const code = encode({
    challenge: query.get("code_challenge"),
    claims: { upn, nonce: query.get("nonce"), ...claims }
  });
  return `/api/auth/callback?${new URLSearchParams({ code, state: query.get("state") })}`;
}

export function createFakeUpstream({ balances = { [EMPLOYEE]: [{ daysLeft: 13.625 }] }, passThrough = globalThis.fetch } = {}) {
  const fake = {
    balances,
    requests: [],
    tokenFailure: null,
    async fetch(input, options = {}) {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return passThrough(input, options);

      const body = String(options.body ?? "");
      const headers = new Headers(options.headers);
      fake.requests.push({ url, body, headers, method: options.method ?? "GET" });

      if (url.hostname === "login.microsoftonline.com") {
        if (url.pathname.endsWith("/oauth2/v2.0/token")) return entraToken(new URLSearchParams(body));
        if (url.pathname.endsWith("/.well-known/openid-configuration")) {
          return jsonResponse({
            authorization_endpoint: `${AUTHORITY}/oauth2/v2.0/authorize`,
            token_endpoint: `${AUTHORITY}/oauth2/v2.0/token`,
            end_session_endpoint: `${AUTHORITY}/oauth2/v2.0/logout`,
            issuer: `${AUTHORITY}/v2.0`,
            jwks_uri: `${AUTHORITY}/discovery/v2.0/keys`
          });
        }
      }

      if (url.href === WORKDAY_ENV.WORKDAY_TOKEN_URL) {
        return jsonResponse({ access_token: "fake-workday-access-token-Tr55" });
      }
      if (`${url.origin}${url.pathname}` === WORKDAY_ENV.WORKDAY_REPORT_URL) {
        return jsonResponse({ Report_Entry: fake.balances[url.searchParams.get("workEmail")] ?? [] });
      }

      throw new Error(`Blocked an outbound request to ${url.hostname} during a test`);
    }
  };

  function entraToken(form) {
    if (fake.tokenFailure) return jsonResponse({ error: fake.tokenFailure, error_description: "refused" }, 400);

    const grant = JSON.parse(Buffer.from(form.get("code"), "base64url").toString("utf8"));
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    if (form.get("client_secret") !== SIGN_IN_ENV.ENTRA_CLIENT_SECRET) return jsonResponse({ error: "invalid_client" }, 401);
    if (challenge !== grant.challenge) return jsonResponse({ error: "invalid_grant" }, 400);

    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: `${AUTHORITY}/v2.0`,
      aud: CLIENT_ID,
      tid: TENANT_ID,
      oid: "55555555-0000-4000-8000-666666666666",
      sub: "fake-subject",
      iat: now,
      nbf: now,
      exp: now + 3600,
      ...grant.claims
    };
    return jsonResponse({
      token_type: "Bearer",
      scope: "openid profile",
      expires_in: 3600,
      ext_expires_in: 3600,
      access_token: "fake-entra-access-token",
      refresh_token: "fake-entra-refresh-token",
      id_token: `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.fake-signature`,
      client_info: encode({ uid: claims.oid, utid: claims.tid })
    });
  }

  return fake;
}
