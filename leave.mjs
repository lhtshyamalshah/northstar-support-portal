// Leave days: company sign-in (Microsoft Entra ID), in-memory sessions and the Workday report.
// Nothing in this module talks to OpenAI, and nothing it logs names a person or holds leave data.
import { randomBytes } from "node:crypto";
import { ConfidentialClientApplication, CryptoProvider } from "@azure/msal-node";
import express from "express";

const SESSION_COOKIE = "northstar_session";
const SIGN_IN_COOKIE = "northstar_signin";
const SESSION_MS = 8 * 60 * 60 * 1000;
const SIGN_IN_MS = 10 * 60 * 1000;
const MAX_PENDING_SIGN_INS = 10_000;
const WORKDAY_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SIGN_IN_FAILED_PATH = "/leave?sign-in=failed";
const SCOPES = ["openid", "profile"];

// The names the new Workday report must be built to.
export const REPORT_FIELDS = { workEmail: "workEmail", asOfDate: "asOfDate", daysLeft: "daysLeft" };

const SIGN_IN_SETTINGS = ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "ENTRA_REDIRECT_URI"];
const WORKDAY_SETTINGS = [
  "WORKDAY_TOKEN_URL",
  "WORKDAY_CLIENT_ID",
  "WORKDAY_CLIENT_SECRET",
  "WORKDAY_REFRESH_TOKEN",
  "WORKDAY_REPORT_URL"
];

/** Returns the named settings, or null when any of them is missing. */
function readSettings(env, names) {
  const entries = names.map((name) => [name, String(env[name] ?? "").trim()]);
  return entries.every(([, value]) => value) ? Object.fromEntries(entries) : null;
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function logEvent(event, outcome, reason) {
  console.log(JSON.stringify({ event, outcome, ...(reason ? { reason } : {}) }));
}

/** A content-free label for a failure. Error messages can carry request details, so they are never logged. */
function failureReason(error) {
  return String(error?.errorCode || error?.reason || error?.name || "Error");
}

function failure(reason) {
  return Object.assign(new Error(reason), { reason });
}

function readCookie(request, name) {
  for (const part of String(request.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function cookieOptions(path, maxAge) {
  return { httpOnly: true, secure: true, sameSite: "lax", path, ...(maxAge ? { maxAge } : {}) };
}

/** A Map whose entries expire. Entries are added in expiry order because every entry lives equally long. */
function expiringStore(lifetimeMs, now, maxEntries = Infinity) {
  const entries = new Map();

  function prune() {
    for (const [key, entry] of entries) {
      if (entry.expiresAt > now() && entries.size < maxEntries) break;
      entries.delete(key);
    }
  }

  return {
    add(value) {
      prune();
      const key = randomBytes(32).toString("base64url");
      entries.set(key, { value, expiresAt: now() + lifetimeMs });
      return key;
    },
    get(key) {
      const entry = key ? entries.get(key) : undefined;
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    delete(key) {
      if (key) entries.delete(key);
    }
  };
}

function defaultSignInClient(settings) {
  // A fresh client per sign-in, so no Microsoft token outlives the request that fetched it.
  return new ConfidentialClientApplication({
    auth: {
      clientId: settings.ENTRA_CLIENT_ID,
      clientSecret: settings.ENTRA_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${encodeURIComponent(settings.ENTRA_TENANT_ID)}`
    }
  });
}

/** Takes the work email (the sign-in name) only from a sign-in issued by the company's tenant to this app. */
function workEmailFromClaims(claims, settings) {
  const sameTenant = String(claims?.tid ?? "").toLowerCase() === settings.ENTRA_TENANT_ID.toLowerCase();
  if (!sameTenant) throw failure("wrong_tenant");
  if (claims.aud !== settings.ENTRA_CLIENT_ID) throw failure("wrong_audience");
  if (typeof claims.upn !== "string" || !claims.upn.trim()) throw failure("no_sign_in_name");
  return claims.upn.trim();
}

/**
 * The browser sends the employee's local date. Every time zone is within one day of the
 * UTC date, so anything further away is refused.
 */
export function isPlausibleLocalDate(value, nowMs) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) return false;
  const utcToday = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.abs(parsed - utcToday) <= DAY_MS;
}

async function readJson(fetchImpl, url, options, stage) {
  const response = await fetchImpl(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(WORKDAY_TIMEOUT_MS)
  });
  if (!response.ok) throw failure(`${stage}_http_${response.status}`);
  return response.json();
}

/**
 * Reads the report as the app's Workday system account. Returns the number exactly as
 * Workday sent it, or null unless the report holds exactly one balance.
 */
async function readDaysLeft(fetchImpl, settings, workEmail, asOfDate) {
  const credentials = Buffer.from(`${settings.WORKDAY_CLIENT_ID}:${settings.WORKDAY_CLIENT_SECRET}`).toString("base64");
  const token = await readJson(fetchImpl, settings.WORKDAY_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: settings.WORKDAY_REFRESH_TOKEN }).toString()
  }, "token");
  if (typeof token?.access_token !== "string" || !token.access_token) throw failure("token_missing");

  const reportUrl = new URL(settings.WORKDAY_REPORT_URL);
  reportUrl.searchParams.set(REPORT_FIELDS.workEmail, workEmail);
  reportUrl.searchParams.set(REPORT_FIELDS.asOfDate, asOfDate);
  reportUrl.searchParams.set("format", "json");
  const report = await readJson(fetchImpl, reportUrl.toString(), {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" }
  }, "report");

  const rows = report?.Report_Entry;
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const value = rows[0]?.[REPORT_FIELDS.daysLeft];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return value;
  return null;
}

/**
 * Routes for the leave days page. The app starts without the sign-in or Workday settings;
 * only these routes are then unavailable.
 */
export function createLeaveRouter({
  env,
  createSignInClient = defaultSignInClient,
  fetchImpl = fetch,
  now = Date.now
}) {
  const signInSettings = readSettings(env, SIGN_IN_SETTINGS);
  const configuredWorkday = readSettings(env, WORKDAY_SETTINGS);
  const workdaySettings = configuredWorkday
    && isHttpsUrl(configuredWorkday.WORKDAY_TOKEN_URL)
    && isHttpsUrl(configuredWorkday.WORKDAY_REPORT_URL)
    ? configuredWorkday
    : null;

  if (!signInSettings || !workdaySettings) {
    console.warn("Leave days is not configured: set the ENTRA_* and WORKDAY_* variables (Workday addresses must use https).");
  }

  const crypto = new CryptoProvider();
  const pendingSignIns = expiringStore(SIGN_IN_MS, now, MAX_PENDING_SIGN_INS);
  const sessions = expiringStore(SESSION_MS, now);
  const router = express.Router();

  router.use(["/api/auth", "/api/leave-days"], (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.get("/api/auth/sign-in", async (_request, response) => {
    if (!signInSettings) {
      logEvent("leave_sign_in", "failed", "not_configured");
      return response.redirect(302, SIGN_IN_FAILED_PATH);
    }
    try {
      const { verifier, challenge } = await crypto.generatePkceCodes();
      const state = crypto.createNewGuid();
      const nonce = crypto.createNewGuid();
      const url = await createSignInClient(signInSettings).getAuthCodeUrl({
        scopes: SCOPES,
        redirectUri: signInSettings.ENTRA_REDIRECT_URI,
        state,
        nonce,
        codeChallenge: challenge,
        codeChallengeMethod: "S256"
      });
      const flowId = pendingSignIns.add({ state, nonce, verifier });
      response.cookie(SIGN_IN_COOKIE, flowId, cookieOptions("/api/auth", SIGN_IN_MS));
      return response.redirect(302, url);
    } catch (error) {
      logEvent("leave_sign_in", "failed", failureReason(error));
      return response.redirect(302, SIGN_IN_FAILED_PATH);
    }
  });

  router.get("/api/auth/callback", async (request, response) => {
    const flowId = readCookie(request, SIGN_IN_COOKIE);
    const flow = pendingSignIns.get(flowId);
    pendingSignIns.delete(flowId); // Each sign-in result can be used once.
    response.clearCookie(SIGN_IN_COOKIE, cookieOptions("/api/auth"));

    try {
      const { code, state } = request.query;
      if (!signInSettings || !flow) throw failure("no_pending_sign_in");
      if (typeof code !== "string" || !code) throw failure("no_code");
      if (state !== flow.state) throw failure("state_mismatch");

      const result = await createSignInClient(signInSettings).acquireTokenByCode(
        {
          code,
          scopes: SCOPES,
          redirectUri: signInSettings.ENTRA_REDIRECT_URI,
          codeVerifier: flow.verifier,
          state: flow.state,
          nonce: flow.nonce
        },
        { code, state, nonce: flow.nonce }
      );
      const workEmail = workEmailFromClaims(result?.idTokenClaims, signInSettings);

      sessions.delete(readCookie(request, SESSION_COOKIE));
      const sessionId = sessions.add({ workEmail });
      response.cookie(SESSION_COOKIE, sessionId, cookieOptions("/", SESSION_MS));
      logEvent("leave_sign_in", "succeeded");
      return response.redirect(302, "/leave");
    } catch (error) {
      logEvent("leave_sign_in", "failed", failureReason(error));
      return response.redirect(302, SIGN_IN_FAILED_PATH);
    }
  });

  router.get("/api/leave-days", async (request, response) => {
    const session = sessions.get(readCookie(request, SESSION_COOKIE));
    if (!session) return response.status(401).json({ error: "Sign in to see your leave days." });

    const unavailable = (status) => response.status(status).json({ error: "Leave days are not available." });
    const { asOfDate } = request.query;
    if (!isPlausibleLocalDate(asOfDate, now())) return unavailable(400);
    if (!workdaySettings) {
      logEvent("leave_lookup", "failed", "not_configured");
      return unavailable(503);
    }

    try {
      // The work email comes only from the session, never from the request.
      const daysLeft = await readDaysLeft(fetchImpl, workdaySettings, session.workEmail, asOfDate);
      if (daysLeft === null) {
        logEvent("leave_lookup", "no_balance");
        return unavailable(404);
      }
      logEvent("leave_lookup", "returned");
      return response.json({ daysLeft });
    } catch (error) {
      logEvent("leave_lookup", "failed", failureReason(error));
      return unavailable(502);
    }
  });

  return router;
}
