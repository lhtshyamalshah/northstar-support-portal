// The whole sign-in and leave flow with the app's real Microsoft client (@azure/msal-node)
// and real defaults. Only the network underneath is faked.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createLeaveRouter } from "../../leave.mjs";
import { approveSignIn, createFakeUpstream } from "../helpers/fake-upstream.mjs";
import {
  CLIENT_ID,
  EMPLOYEE,
  FULL_ENV,
  OTHER_EMPLOYEE,
  SIGN_IN_ENV,
  TENANT_ID,
  captureConsole,
  get,
  leaveDays,
  serve,
  setCookies,
  startSignIn
} from "../helpers/leave-fixtures.mjs";

const FAILED = "/leave?sign-in=failed";
const today = () => new Date().toISOString().slice(0, 10);

let upstream;
let server;
let logs;

beforeEach(async (t) => {
  upstream = createFakeUpstream();
  t.mock.method(globalThis, "fetch", upstream.fetch);
  logs = captureConsole(t);
  // No createSignInClient or fetchImpl: the production defaults are under test.
  server = await serve(createLeaveRouter({ env: FULL_ENV }));
});

afterEach(async () => {
  await server.close();
});

/** Runs sign-in as a browser would, with Microsoft approving the given employee. */
async function signInThroughMicrosoft(options) {
  const flow = await startSignIn(server.base);
  const callback = await get(server.base, approveSignIn(flow.location, options), {
    cookies: { northstar_signin: flow.flowCookie }
  });
  return { flow, callback, session: setCookies(callback).northstar_session?.value };
}

const tokenRequests = () => upstream.requests.filter((request) => request.url.pathname.endsWith("/oauth2/v2.0/token")
  && request.url.hostname === "login.microsoftonline.com");

describe("company sign-in with the real client", () => {
  it("sends the browser to the company tenant with PKCE, state and nonce", async () => {
    const { response, location } = await startSignIn(server.base);

    assert.equal(response.status, 302);
    const url = new URL(location);
    assert.equal(url.origin, "https://login.microsoftonline.com");
    assert.equal(url.pathname, `/${TENANT_ID}/oauth2/v2.0/authorize`);
    assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(url.searchParams.get("redirect_uri"), SIGN_IN_ENV.ENTRA_REDIRECT_URI);
    assert.equal(url.searchParams.get("response_type"), "code");
    // A query response is a GET, which the SameSite=Lax sign-in cookie accompanies.
    assert.equal(url.searchParams.get("response_mode"), "query");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    for (const scope of ["openid", "profile"]) assert.ok(url.searchParams.get("scope").split(" ").includes(scope));
    for (const name of ["state", "nonce", "code_challenge"]) assert.ok(url.searchParams.get(name), name);
    assert.ok(!location.includes(SIGN_IN_ENV.ENTRA_CLIENT_SECRET), "the secret must never reach the browser");
  });

  it("signs in, then reads the employee's own leave days", async () => {
    const { callback, session } = await signInThroughMicrosoft();

    assert.equal(callback.headers.get("location"), "/leave");
    const response = await leaveDays(server.base, session, `?asOfDate=${today()}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { daysLeft: 13.625 });

    const report = upstream.requests.at(-1);
    assert.equal(report.url.searchParams.get("workEmail"), EMPLOYEE);
  });

  it("proves the app's identity with its client secret and PKCE verifier (TR-41)", async () => {
    const { flow } = await signInThroughMicrosoft();

    const [request] = tokenRequests();
    assert.equal(request.url.pathname, `/${TENANT_ID}/oauth2/v2.0/token`);
    const form = new URLSearchParams(request.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("client_id"), CLIENT_ID);
    assert.equal(form.get("client_secret"), SIGN_IN_ENV.ENTRA_CLIENT_SECRET);
    assert.equal(form.get("redirect_uri"), SIGN_IN_ENV.ENTRA_REDIRECT_URI);
    assert.equal(
      createHash("sha256").update(form.get("code_verifier")).digest("base64url"),
      new URL(flow.location).searchParams.get("code_challenge")
    );
  });

  it("asks Microsoft afresh for each sign-in, with each employee kept apart", async () => {
    upstream.balances[OTHER_EMPLOYEE] = [{ daysLeft: 4 }];
    const mine = await signInThroughMicrosoft();
    const theirs = await signInThroughMicrosoft({ upn: OTHER_EMPLOYEE });

    assert.equal(tokenRequests().length, 2);
    const read = async (session) => (await leaveDays(server.base, session, `?asOfDate=${today()}`)).json();
    assert.deepEqual(await read(mine.session), { daysLeft: 13.625 });
    assert.deepEqual(await read(theirs.session), { daysLeft: 4 });
  });

  const refused = [
    ["a nonce from another sign-in", { claims: { nonce: "someone-elses-nonce" } }, "nonce_mismatch"],
    ["no nonce", { claims: { nonce: undefined } }, "nonce_mismatch"],
    ["another tenant", { claims: { tid: "99999999-0000-4000-8000-000000000000" } }, "wrong_tenant"],
    ["another audience", { claims: { aud: "some-other-app" } }, "wrong_audience"],
    ["no sign-in name", { claims: { upn: undefined, preferred_username: EMPLOYEE } }, "no_sign_in_name"]
  ];

  for (const [label, options, reason] of refused) {
    it(`starts no session when Microsoft's token has ${label} (TR-23)`, async () => {
      const { callback, session } = await signInThroughMicrosoft(options);

      assert.equal(callback.headers.get("location"), FAILED);
      assert.equal(session, undefined);
      assert.equal(tokenRequests().length, 1, "the code was exchanged, then the result refused");
      assert.ok(logs.some((line) => line.includes(`"reason":"${reason}"`)), `expected reason ${reason}`);
    });
  }

  it("starts no session when Microsoft refuses the code", async () => {
    upstream.tokenFailure = "invalid_grant";

    const { callback, session } = await signInThroughMicrosoft();

    assert.equal(callback.headers.get("location"), FAILED);
    assert.equal(session, undefined);
  });

  it("never exchanges a code whose state does not match", async () => {
    const flow = await startSignIn(server.base);
    const path = approveSignIn(flow.location).replace(/state=[^&]+/, "state=forged");

    const callback = await get(server.base, path, { cookies: { northstar_signin: flow.flowCookie } });

    assert.equal(callback.headers.get("location"), FAILED);
    assert.equal(tokenRequests().length, 0);
  });

  it("logs no secret, token, code or email through the real client (TR-31)", async () => {
    const { flow, session } = await signInThroughMicrosoft();
    await leaveDays(server.base, session, `?asOfDate=${today()}`);
    await signInThroughMicrosoft({ claims: { nonce: "wrong" } });
    upstream.tokenFailure = "invalid_client";
    await signInThroughMicrosoft();

    const output = logs.join(" ");
    const code = new URLSearchParams(tokenRequests()[0].body).get("code");
    const sensitive = [
      EMPLOYEE,
      "13.625",
      code,
      session,
      flow.flowCookie,
      SIGN_IN_ENV.ENTRA_CLIENT_SECRET,
      "fake-entra-access-token",
      "fake-entra-refresh-token",
      "fake-workday-access-token"
    ];
    for (const value of sensitive) {
      assert.ok(!output.includes(value), `a log line holds a sensitive value starting "${value.slice(0, 6)}"`);
    }
  });

  it("calls only Microsoft sign-in and Workday, never an AI service (TR-32)", async () => {
    const { session } = await signInThroughMicrosoft();
    await leaveDays(server.base, session, `?asOfDate=${today()}`);

    const hosts = new Set(upstream.requests.map((request) => request.url.hostname));
    assert.deepEqual([...hosts].sort(), ["login.microsoftonline.com", "workday.example.test"]);
  });
});
