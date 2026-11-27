import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createLeaveRouter, isPlausibleLocalDate, REPORT_FIELDS } from "../leave.mjs";
import {
  CLIENT_ID,
  EMPLOYEE,
  FULL_ENV,
  NOW,
  OTHER_EMPLOYEE,
  SIGN_IN_ENV,
  TODAY,
  WORKDAY_ENV,
  captureConsole,
  claimsFor,
  fakeSignInClient,
  fakeWorkday,
  finishSignIn,
  get,
  jsonResponse,
  leaveDays,
  serve,
  setCookies,
  signIn,
  startSignIn
} from "./helpers/leave-fixtures.mjs";

const FAILED = "/leave?sign-in=failed";
const EIGHT_HOURS = 8 * 60 * 60 * 1000;

let clock;
let entra;
let workday;
let logs;
let servers;

async function start(env = FULL_ENV) {
  const server = await serve(createLeaveRouter({
    env,
    createSignInClient: entra.create,
    fetchImpl: workday.fetch,
    now: () => clock
  }));
  servers.push(server);
  return server.base;
}

beforeEach((t) => {
  clock = NOW;
  entra = fakeSignInClient();
  workday = fakeWorkday();
  servers = [];
  logs = captureConsole(t);
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** A refused sign-in: back to the page, with no session cookie issued. */
function assertSignInRefused(response) {
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), FAILED);
  assert.equal(setCookies(response).northstar_session, undefined);
}

async function assertNoNumber(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.doesNotMatch(body.error, /\d/);
}

describe("GET /api/auth/sign-in", () => {
  it("redirects to the company sign-in with state, nonce and PKCE (TR-23)", async () => {
    const base = await start();
    const { response, state } = await startSignIn(base);

    assert.equal(response.status, 302);
    assert.match(response.headers.get("location"), /^https:\/\/login\.fake\.test\/authorize\?/);
    assert.equal(response.headers.get("cache-control"), "no-store");

    const [request] = entra.authUrlRequests;
    assert.deepEqual(request.scopes, ["openid", "profile"]);
    assert.equal(request.redirectUri, SIGN_IN_ENV.ENTRA_REDIRECT_URI);
    assert.equal(request.codeChallengeMethod, "S256");
    assert.equal(request.state, state);
    assert.ok(request.state && request.nonce && request.codeChallenge);
  });

  it("gives the browser a short-lived, protected cookie for the pending sign-in (TR-38)", async () => {
    const base = await start();
    const cookie = setCookies((await startSignIn(base)).response).northstar_signin;

    assert.ok(cookie.value.length >= 40);
    assert.equal(cookie.attributes.httponly, true);
    assert.equal(cookie.attributes.secure, true);
    assert.equal(cookie.attributes.samesite, "Lax");
    assert.equal(cookie.attributes.path, "/api/auth");
    assert.equal(cookie.attributes["max-age"], "600");
  });

  it("uses a new state, nonce and challenge every time", async () => {
    const base = await start();
    await startSignIn(base);
    await startSignIn(base);

    const [first, second] = entra.authUrlRequests;
    assert.notEqual(first.state, second.state);
    assert.notEqual(first.nonce, second.nonce);
    assert.notEqual(first.codeChallenge, second.codeChallenge);
  });

  it("returns to the page when the sign-in address cannot be built", async () => {
    entra.authUrlError = new Error("authority unavailable");
    const base = await start();

    const response = await get(base, "/api/auth/sign-in");

    assertSignInRefused(response);
    assert.equal(setCookies(response).northstar_signin, undefined);
  });
});

describe("GET /api/auth/callback", () => {
  it("starts a session after a valid sign-in and returns to the leave page", async () => {
    const base = await start();
    const flow = await startSignIn(base);

    const response = await finishSignIn(base, flow);

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/leave");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(setCookies(response).northstar_session.value.length >= 40);
  });

  it("sets the session cookie HttpOnly, Secure, SameSite=Lax for 8 hours (TR-38, TR-40)", async () => {
    const base = await start();
    const response = await finishSignIn(base, await startSignIn(base));
    const cookies = setCookies(response);

    const session = cookies.northstar_session;
    assert.equal(session.attributes.httponly, true);
    assert.equal(session.attributes.secure, true);
    assert.equal(session.attributes.samesite, "Lax");
    assert.equal(session.attributes.path, "/");
    assert.equal(session.attributes["max-age"], String(EIGHT_HOURS / 1000));
    assert.equal(session.attributes.domain, undefined);
    assert.ok(!decodeURIComponent(session.value).includes(EMPLOYEE), "the cookie must not carry the identity");

    // The pending sign-in cookie is cleared on the same path it was set on.
    assert.equal(cookies.northstar_signin.value, "");
    assert.equal(cookies.northstar_signin.attributes.path, "/api/auth");
    assert.match(cookies.northstar_signin.attributes.expires, /1970/);
  });

  it("exchanges the code with the PKCE verifier, state and nonce of this sign-in", async () => {
    const base = await start();
    await finishSignIn(base, await startSignIn(base), { code: "the-code" });

    const [authRequest] = entra.authUrlRequests;
    const [{ request, payload }] = entra.exchanges;
    assert.equal(request.code, "the-code");
    assert.equal(request.redirectUri, SIGN_IN_ENV.ENTRA_REDIRECT_URI);
    assert.equal(createHash("sha256").update(request.codeVerifier).digest("base64url"), authRequest.codeChallenge);
    assert.equal(request.state, authRequest.state);
    assert.equal(request.nonce, authRequest.nonce);
    assert.deepEqual(payload, { code: "the-code", state: authRequest.state, nonce: authRequest.nonce });
  });

  it("refuses a state that does not match, without exchanging the code", async () => {
    const base = await start();
    const flow = await startSignIn(base);

    const response = await finishSignIn(base, { ...flow, state: "forged-state" });

    assertSignInRefused(response);
    assert.equal(entra.exchanges.length, 0);
    // The pending sign-in is spent, so the right state cannot be tried afterwards.
    assertSignInRefused(await finishSignIn(base, flow));
    assert.equal(entra.exchanges.length, 0);
  });

  it("refuses a missing or repeated state", async () => {
    const base = await start();

    const first = await startSignIn(base);
    assertSignInRefused(await finishSignIn(base, { ...first, state: null }));

    const second = await startSignIn(base);
    assertSignInRefused(await get(base, `/api/auth/callback?code=c&state=${second.state}&state=${second.state}`, {
      cookies: { northstar_signin: second.flowCookie }
    }));
    assert.equal(entra.exchanges.length, 0);
  });

  it("refuses a callback this browser did not start", async () => {
    const base = await start();
    const flow = await startSignIn(base);

    assertSignInRefused(await finishSignIn(base, { ...flow, flowCookie: undefined }));
    assertSignInRefused(await finishSignIn(base, { ...flow, flowCookie: "made-up-flow-id" }));
    assert.equal(entra.exchanges.length, 0);
  });

  it("refuses one browser's state with another browser's sign-in cookie", async () => {
    const base = await start();
    const mine = await startSignIn(base);
    const theirs = await startSignIn(base);

    assertSignInRefused(await finishSignIn(base, { flowCookie: mine.flowCookie, state: theirs.state }));
    assert.equal(entra.exchanges.length, 0);
  });

  it("refuses a replayed callback", async () => {
    const base = await start();
    const flow = await startSignIn(base);
    assert.equal((await finishSignIn(base, flow)).headers.get("location"), "/leave");

    assertSignInRefused(await finishSignIn(base, flow));
    assert.equal(entra.exchanges.length, 1);
  });

  it("lets only one of two simultaneous callbacks through", async () => {
    const base = await start();
    const flow = await startSignIn(base);

    const responses = await Promise.all([finishSignIn(base, flow), finishSignIn(base, flow)]);

    assert.deepEqual(responses.map((response) => response.headers.get("location")).sort(), ["/leave", FAILED]);
    assert.equal(entra.exchanges.length, 1);
  });

  it("refuses a sign-in left pending for 10 minutes", async () => {
    const base = await start();
    const flow = await startSignIn(base);
    clock += 10 * 60 * 1000;

    assertSignInRefused(await finishSignIn(base, flow));
    assert.equal(entra.exchanges.length, 0);
  });

  it("refuses a result with no code, as when the employee cancels", async () => {
    const base = await start();
    const flow = await startSignIn(base);

    assertSignInRefused(await get(base, `/api/auth/callback?error=access_denied&state=${flow.state}`, {
      cookies: { northstar_signin: flow.flowCookie }
    }));
    assert.equal(entra.exchanges.length, 0);
  });

  it("refuses the sign-in when the code exchange fails", async () => {
    entra.exchangeError = Object.assign(new Error("nope"), { errorCode: "invalid_grant" });
    const base = await start();

    assertSignInRefused(await finishSignIn(base, await startSignIn(base)));
  });

  const badClaims = [
    ["another tenant", claimsFor(EMPLOYEE, { tid: "99999999-0000-4000-8000-000000000000" }), "wrong_tenant"],
    ["no tenant", claimsFor(EMPLOYEE, { tid: undefined }), "wrong_tenant"],
    ["another audience", claimsFor(EMPLOYEE, { aud: "some-other-app" }), "wrong_audience"],
    ["a list as audience", claimsFor(EMPLOYEE, { aud: [CLIENT_ID] }), "wrong_audience"],
    ["no sign-in name", claimsFor(undefined), "no_sign_in_name"],
    ["a blank sign-in name", claimsFor("   "), "no_sign_in_name"],
    ["a non-text sign-in name", claimsFor(42), "no_sign_in_name"],
    ["only other name claims", claimsFor(undefined, { preferred_username: EMPLOYEE, email: EMPLOYEE }), "no_sign_in_name"],
    ["no claims at all", undefined, "wrong_tenant"]
  ];

  for (const [label, claims, reason] of badClaims) {
    it(`refuses a sign-in with ${label} (TR-23, TR-24)`, async () => {
      entra.claims = claims;
      const base = await start();

      assertSignInRefused(await finishSignIn(base, await startSignIn(base)));

      assert.ok(logs.some((line) => line.includes(`"reason":"${reason}"`)), `expected reason ${reason}`);
      assert.equal(workday.calls.length, 0);
    });
  }

  it("accepts the company tenant whatever the letter case of its ID", async () => {
    entra.claims = claimsFor(EMPLOYEE, { tid: SIGN_IN_ENV.ENTRA_TENANT_ID.toUpperCase() });
    const base = await start();

    assert.ok(await signIn(base));
  });

  it("replaces the earlier session when the same browser signs in again", async () => {
    const base = await start();
    const first = await signIn(base);

    entra.claims = claimsFor(OTHER_EMPLOYEE);
    const response = await finishSignIn(base, await startSignIn(base), { cookies: { northstar_session: first } });
    const second = setCookies(response).northstar_session.value;

    assert.notEqual(second, first);
    assert.equal((await leaveDays(base, first)).status, 401);
    assert.equal(workday.calls.length, 0);
  });
});

describe("GET /api/leave-days: who may ask (TR-23, TR-27)", () => {
  it("answers 401 without a session and reads nothing from Workday", async () => {
    const base = await start();

    await assertNoNumber(await leaveDays(base, null), 401);
    await assertNoNumber(await leaveDays(base, "made-up-session"), 401);
    await assertNoNumber(await leaveDays(base, null, `?asOfDate=${TODAY}&workEmail=${EMPLOYEE}`), 401);
    assert.equal(workday.calls.length, 0);
  });

  it("does not accept the pending sign-in cookie as a session", async () => {
    const base = await start();
    const { flowCookie } = await startSignIn(base);

    await assertNoNumber(await leaveDays(base, flowCookie), 401);
  });

  it("takes the work email only from the session, ignoring anything in the request (TR-24)", async () => {
    workday.balances[OTHER_EMPLOYEE] = [{ daysLeft: 99 }];
    const base = await start();
    const session = await signIn(base);
    const other = encodeURIComponent(OTHER_EMPLOYEE);

    const response = await leaveDays(
      base,
      session,
      `?asOfDate=${TODAY}&workEmail=${other}&email=${other}&upn=${other}&format=xml`,
      { "X-Work-Email": OTHER_EMPLOYEE }
    );

    assert.deepEqual(await response.json(), { daysLeft: 13.625 });
    const reportCall = workday.calls[1].url;
    assert.deepEqual(reportCall.searchParams.getAll("workEmail"), [EMPLOYEE]);
    assert.equal(reportCall.searchParams.get("format"), "json");
    assert.ok(!reportCall.href.includes("noah"));
  });

  it("gives each employee only their own number", async () => {
    workday.balances[OTHER_EMPLOYEE] = [{ daysLeft: 4 }];
    const base = await start();
    const mine = await signIn(base);
    entra.claims = claimsFor(OTHER_EMPLOYEE);
    const theirs = await signIn(base);

    assert.deepEqual(await (await leaveDays(base, mine)).json(), { daysLeft: 13.625 });
    assert.deepEqual(await (await leaveDays(base, theirs)).json(), { daysLeft: 4 });
  });

  it("ends the session exactly 8 hours after sign-in, however often it is used (TR-40)", async () => {
    const base = await start();
    const session = await signIn(base);

    for (const elapsed of [EIGHT_HOURS / 2, EIGHT_HOURS - 1]) {
      clock = NOW + elapsed;
      assert.equal((await leaveDays(base, session)).status, 200);
    }

    clock = NOW + EIGHT_HOURS;
    const callsBefore = workday.calls.length;
    await assertNoNumber(await leaveDays(base, session), 401);
    assert.equal(workday.calls.length, callsBefore);
  });

  it("keeps sessions in process memory only, so a restart signs everyone out (TR-40)", async () => {
    const session = await signIn(await start());
    const restarted = await start();

    await assertNoNumber(await leaveDays(restarted, session), 401);
  });
});

describe("GET /api/leave-days: the Workday read", () => {
  it("returns the balance with no-store and nothing else (FR-52, TR-29)", async () => {
    const base = await start();
    const response = await leaveDays(base, await signIn(base));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { daysLeft: 13.625 });
  });

  it("refreshes the system account's token, then reads the report with it (TR-39, TR-42)", async () => {
    const base = await start();
    await leaveDays(base, await signIn(base));

    assert.equal(workday.calls.length, 2);
    const [token, report] = workday.calls;

    assert.equal(token.url.href, WORKDAY_ENV.WORKDAY_TOKEN_URL);
    assert.equal(token.options.method, "POST");
    const basic = Buffer.from(`${WORKDAY_ENV.WORKDAY_CLIENT_ID}:${WORKDAY_ENV.WORKDAY_CLIENT_SECRET}`).toString("base64");
    assert.equal(token.options.headers.Authorization, `Basic ${basic}`);
    assert.equal(token.options.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(token.options.body)), {
      grant_type: "refresh_token",
      refresh_token: WORKDAY_ENV.WORKDAY_REFRESH_TOKEN
    });

    assert.equal(report.options.method ?? "GET", "GET");
    assert.equal(report.options.headers.Authorization, "Bearer fake-workday-access-token-Tr55");
    // Exactly these parameters: no leave plan name is sent.
    assert.deepEqual(Object.fromEntries(report.url.searchParams), {
      workEmail: EMPLOYEE,
      asOfDate: TODAY,
      format: "json"
    });

    for (const call of workday.calls) {
      assert.equal(call.options.redirect, "error", "credentials must never follow a redirect");
      assert.ok(call.options.signal instanceof AbortSignal, "every call needs a timeout");
    }
  });

  it("keeps parameters already present in the report address", async () => {
    const base = await start({ ...FULL_ENV, WORKDAY_REPORT_URL: `${WORKDAY_ENV.WORKDAY_REPORT_URL}?tenantView=1` });
    await leaveDays(base, await signIn(base));

    assert.equal(workday.calls[1].url.searchParams.get("tenantView"), "1");
    assert.equal(workday.calls[1].url.searchParams.get("workEmail"), EMPLOYEE);
  });

  it("uses the report field names the Workday report must be built to (TR-43)", () => {
    assert.deepEqual(REPORT_FIELDS, { workEmail: "workEmail", asOfDate: "asOfDate", daysLeft: "daysLeft" });
  });

  it("asks for the balance as of the employee's local date (TR-25)", async () => {
    const base = await start();
    const session = await signIn(base);

    for (const date of ["2026-11-26", "2026-11-27", "2026-11-28"]) {
      workday.calls.length = 0;
      assert.equal((await leaveDays(base, session, `?asOfDate=${date}`)).status, 200);
      assert.equal(workday.calls[1].url.searchParams.get("asOfDate"), date);
    }
  });

  it("answers 400 to a missing or implausible date without calling Workday", async () => {
    const base = await start();
    const session = await signIn(base);
    const queries = [
      "",
      "?asOfDate=",
      "?asOfDate=2026-11-25",
      "?asOfDate=2026-11-29",
      "?asOfDate=2027-11-27",
      "?asOfDate=27-11-2026",
      "?asOfDate=2026-11-27T00:00:00Z",
      "?asOfDate=today",
      `?asOfDate=${TODAY}&asOfDate=${TODAY}`,
      `?asOfDate=${TODAY}%26workEmail%3Dsomeone`
    ];

    for (const query of queries) {
      await assertNoNumber(await leaveDays(base, session, query), 400);
    }
    assert.equal(workday.calls.length, 0);
  });

  for (const value of [0, 7, 12.5, 13.625, -2, "12.50", "0", "-1.5"]) {
    it(`passes the recorded number ${JSON.stringify(value)} on unchanged (FR-52, TR-25)`, async () => {
      workday.balances[EMPLOYEE] = [{ daysLeft: value }];
      const base = await start();

      const response = await leaveDays(base, await signIn(base));

      assert.equal(await response.text(), JSON.stringify({ daysLeft: value }));
    });
  }

  const noBalance = [
    ["no rows", { Report_Entry: [] }],
    ["two different rows", { Report_Entry: [{ daysLeft: 5 }, { daysLeft: 8 }] }],
    ["two equal rows", { Report_Entry: [{ daysLeft: 5 }, { daysLeft: 5 }] }],
    ["a row plus an empty row", { Report_Entry: [{ daysLeft: 5 }, {}] }],
    ["no row list", {}],
    ["a row list that is not a list", { Report_Entry: { daysLeft: 5 } }],
    ["an empty body", null],
    ["a null row", { Report_Entry: [null] }],
    ["no balance field", { Report_Entry: [{ hoursLeft: 40 }] }],
    ["a null balance", { Report_Entry: [{ daysLeft: null }] }],
    ["an empty balance", { Report_Entry: [{ daysLeft: "" }] }],
    ["a worded balance", { Report_Entry: [{ daysLeft: "12 days" }] }],
    ["a boolean balance", { Report_Entry: [{ daysLeft: true }] }],
    ["a list balance", { Report_Entry: [{ daysLeft: [5] }] }]
  ];

  for (const [label, body] of noBalance) {
    it(`gives no number when the report holds ${label} (TR-37)`, async () => {
      workday.report = () => jsonResponse(body);
      const base = await start();

      await assertNoNumber(await leaveDays(base, await signIn(base)), 404);
    });
  }

  it("reads Workday on every request and keeps no copy of the number (TR-28)", async () => {
    const base = await start();
    const session = await signIn(base);
    assert.deepEqual(await (await leaveDays(base, session)).json(), { daysLeft: 13.625 });

    workday.balances[EMPLOYEE] = [{ daysLeft: 12.625 }];
    assert.deepEqual(await (await leaveDays(base, session)).json(), { daysLeft: 12.625 });
    assert.equal(workday.calls.length, 4);

    // Once Workday is down, no earlier number is served.
    workday.report = () => jsonResponse({}, 503);
    await assertNoNumber(await leaveDays(base, session), 502);
  });

  const failures = [
    ["the token endpoint refuses", "token", () => jsonResponse({ error: "invalid_grant" }, 400), 1],
    ["the token endpoint is down", "token", () => jsonResponse({}, 500), 1],
    ["the token reply has no token", "token", () => jsonResponse({ token_type: "Bearer" }), 1],
    ["the token reply is not JSON", "token", () => new Response("<html>"), 1],
    ["the token call cannot connect", "token", () => { throw new TypeError("fetch failed"); }, 1],
    ["the report refuses", "report", () => jsonResponse({}, 403), 2],
    ["the report errors", "report", () => jsonResponse({ Report_Entry: [{ daysLeft: 5 }] }, 500), 2],
    ["the report is not JSON", "report", () => new Response("Report_Entry"), 2],
    ["the report times out", "report", () => { throw new DOMException("timed out", "TimeoutError"); }, 2]
  ];

  for (const [label, stage, behaviour, expectedCalls] of failures) {
    it(`gives no number when ${label}`, async () => {
      workday[stage] = behaviour;
      const base = await start();

      await assertNoNumber(await leaveDays(base, await signIn(base)), 502);

      assert.equal(workday.calls.length, expectedCalls);
    });
  }
});

describe("isPlausibleLocalDate", () => {
  const at = (iso) => Date.parse(iso);

  it("accepts the UTC date and one day either side, at any time of day", () => {
    for (const time of ["00:00:00.000", "12:00:00.000", "23:59:59.999"]) {
      const now = at(`2026-11-27T${time}Z`);
      for (const date of ["2026-11-26", "2026-11-27", "2026-11-28"]) {
        assert.equal(isPlausibleLocalDate(date, now), true, `${date} at ${time}`);
      }
      for (const date of ["2026-11-25", "2026-11-29"]) {
        assert.equal(isPlausibleLocalDate(date, now), false, `${date} at ${time}`);
      }
    }
  });

  it("works across month, year and leap day boundaries", () => {
    assert.equal(isPlausibleLocalDate("2027-01-01", at("2026-12-31T23:00:00Z")), true);
    assert.equal(isPlausibleLocalDate("2026-12-31", at("2027-01-01T01:00:00Z")), true);
    assert.equal(isPlausibleLocalDate("2028-02-29", at("2028-03-01T00:00:00Z")), true);
  });

  it("refuses dates that do not exist", () => {
    assert.equal(isPlausibleLocalDate("2026-02-29", at("2026-03-01T00:00:00Z")), false);
    assert.equal(isPlausibleLocalDate("2026-11-31", at("2026-12-01T00:00:00Z")), false);
    assert.equal(isPlausibleLocalDate("2026-13-01", at("2026-12-31T00:00:00Z")), false);
    assert.equal(isPlausibleLocalDate("2026-11-00", at("2026-11-01T00:00:00Z")), false);
  });

  it("refuses anything that is not a YYYY-MM-DD string", () => {
    for (const value of [undefined, null, 20261127, ["2026-11-27"], {}, "", "2026-11-7", " 2026-11-27", "2026-11-27 ", "+002026-11-27"]) {
      assert.equal(isPlausibleLocalDate(value, NOW), false, JSON.stringify(value));
    }
  });
});

describe("missing or unsafe settings (TR-35)", () => {
  it("still starts and serves other routes with no leave settings at all", async () => {
    const base = await start({});

    assert.equal((await get(base, "/api/health")).status, 200);
    assertSignInRefused(await get(base, "/api/auth/sign-in"));
    assertSignInRefused(await get(base, "/api/auth/callback?code=c&state=s"));
    await assertNoNumber(await leaveDays(base, null), 401);
    assert.equal(entra.settings.length, 0);
    assert.equal(workday.calls.length, 0);
    assert.ok(logs.some((line) => line.includes("Leave days is not configured")));
  });

  for (const name of Object.keys(SIGN_IN_ENV)) {
    it(`cannot sign anyone in without ${name}`, async () => {
      const base = await start({ ...FULL_ENV, [name]: "   " });

      assertSignInRefused(await get(base, "/api/auth/sign-in"));
      assert.equal(entra.settings.length, 0);
    });
  }

  for (const name of Object.keys(WORKDAY_ENV)) {
    it(`gives no number without ${name}`, async () => {
      const env = { ...FULL_ENV };
      delete env[name];
      const base = await start(env);

      await assertNoNumber(await leaveDays(base, await signIn(base)), 503);
      assert.equal(workday.calls.length, 0);
    });
  }

  for (const name of ["WORKDAY_TOKEN_URL", "WORKDAY_REPORT_URL"]) {
    for (const address of ["http://workday.example.test/path", "ftp://workday.example.test/path", "workday.example.test/path"]) {
      it(`refuses ${name} set to ${address}`, async () => {
        const base = await start({ ...FULL_ENV, [name]: address });

        await assertNoNumber(await leaveDays(base, await signIn(base)), 503);
        assert.equal(workday.calls.length, 0, "no credential may leave over a non-https address");
      });
    }
  }

  it("does not print any setting value in the not-configured warning", async () => {
    await start({ ...FULL_ENV, WORKDAY_TOKEN_URL: "http://workday.example.test/token" });
    const output = logs.join(" ");

    assert.match(output, /not configured/);
    for (const value of [SIGN_IN_ENV.ENTRA_CLIENT_SECRET, WORKDAY_ENV.WORKDAY_CLIENT_SECRET, WORKDAY_ENV.WORKDAY_REFRESH_TOKEN]) {
      assert.ok(!output.includes(value));
    }
  });
});

describe("logging (TR-31)", () => {
  it("writes no secret, token, cookie, email or leave value on success or failure", async () => {
    const sensitive = [
      EMPLOYEE,
      "ava.employee",
      "13.625",
      "fake-auth-code-Qx12",
      "fake-entra-access-token",
      "fake-entra-id-token",
      "fake-workday-access-token-Tr55",
      SIGN_IN_ENV.ENTRA_CLIENT_SECRET,
      WORKDAY_ENV.WORKDAY_CLIENT_SECRET,
      WORKDAY_ENV.WORKDAY_REFRESH_TOKEN,
      Buffer.from(`${WORKDAY_ENV.WORKDAY_CLIENT_ID}:${WORKDAY_ENV.WORKDAY_CLIENT_SECRET}`).toString("base64")
    ];
    // Library errors can repeat request details in their message, so make the fakes do it.
    const leaky = () => new Error(`request failed: ${sensitive.join(" ")}`);
    const base = await start();

    const flow = await startSignIn(base);
    const callback = await finishSignIn(base, flow);
    const session = setCookies(callback).northstar_session.value;
    await leaveDays(base, session);
    await leaveDays(base, session, "?asOfDate=bad");
    await finishSignIn(base, flow);
    workday.report = () => jsonResponse({ Report_Entry: [{ daysLeft: 13.625 }, { daysLeft: 13.625 }] });
    await leaveDays(base, session);
    workday.report = () => { throw leaky(); };
    await leaveDays(base, session);
    workday.token = () => new Response(sensitive.join(" "));
    await leaveDays(base, session);
    entra.exchangeError = leaky();
    await finishSignIn(base, await startSignIn(base));
    entra.exchangeError = null;
    entra.claims = claimsFor(EMPLOYEE, { tid: "another-tenant" });
    await finishSignIn(base, await startSignIn(base));
    entra.authUrlError = leaky();
    await startSignIn(base);

    const [{ request }] = entra.exchanges;
    sensitive.push(session, flow.flowCookie, flow.state, request.nonce, request.codeVerifier);

    const output = logs.join(" ");
    for (const value of sensitive) {
      assert.ok(!output.includes(value), `a log line holds a sensitive value starting "${value.slice(0, 6)}"`);
    }
    assert.ok(logs.length >= 7);
    for (const line of logs) {
      const entry = JSON.parse(line);
      assert.deepEqual(Object.keys(entry).filter((key) => !["event", "outcome", "reason"].includes(key)), []);
      assert.match(entry.event, /^leave_(sign_in|lookup)$/);
    }
  });
});
