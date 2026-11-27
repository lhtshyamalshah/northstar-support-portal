// The real server.mjs, run as a child process that this test stops itself. It starts in an
// empty temporary folder (so no local .env is read), with governance off, a fake OpenAI on
// loopback, and Microsoft and Workday faked inside the child. Nothing leaves the machine.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { approveSignIn } from "../helpers/fake-upstream.mjs";
import { EMPLOYEE, FULL_ENV, get, leaveDays, setCookies, startSignIn } from "../helpers/leave-fixtures.mjs";

const serverPath = fileURLToPath(new URL("../../server.mjs", import.meta.url));
const preload = new URL("../helpers/preload-fake-upstream.mjs", import.meta.url).href;
const today = () => new Date().toISOString().slice(0, 10);

let workFolder;

before(() => {
  workFolder = mkdtempSync(join(tmpdir(), "northstar-server-test-"));
  mkdirSync(join(workFolder, "dist"));
  writeFileSync(join(workFolder, "dist", "index.html"), '<!doctype html><div id="root"></div>');
});

after(() => {
  rmSync(workFolder, { recursive: true, force: true });
});

async function freePort() {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  await once(probe, "close");
  return port;
}

/** Starts server.mjs with only the variables given here, never the caller's environment. */
async function startServer(env) {
  const port = await freePort();
  const system = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP"]
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]));
  const child = spawn(process.execPath, ["--import", preload, serverPath], {
    cwd: workFolder,
    env: { ...system, NODE_ENV: "production", ZBRAIN_GOVERNANCE: "false", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The server did not start: ${output}`)), 20_000);
    const collect = (chunk) => {
      output += chunk;
      if (output.includes("agents are enabled") || output.includes("Demo fallback is enabled")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The server exited with ${code}: ${output}`));
    });
  }).catch(async (error) => {
    await stop();
    throw error;
  });

  return { base: `http://127.0.0.1:${port}`, output: () => output, stop };
}

const chat = (base, message, cookie) => fetch(`${base}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify({ message, history: [], activeAgent: "support" })
});

describe("server.mjs without any leave setting", () => {
  let server;

  before(async () => {
    server = await startServer({});
  });

  after(async () => {
    await server?.stop();
  });

  it("starts and keeps chat, orders and health open without a sign-in (TR-27)", async () => {
    const health = await get(server.base, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.equal((await health.json()).ok, true);

    const orders = await get(server.base, "/api/orders");
    assert.equal(orders.status, 200);
    assert.equal(orders.headers.get("cache-control"), "no-store");
    assert.equal((await orders.json()).orders.length, 10);

    const reply = await chat(server.base, "Where is order NS-1002?");
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("cache-control"), "no-store");
    assert.match((await reply.json()).reply, /NS-1002 is shipped/);
  });

  it("makes only the leave days unavailable", async () => {
    const days = await leaveDays(server.base, null, `?asOfDate=${today()}`);
    assert.equal(days.status, 401);
    assert.equal(days.headers.get("cache-control"), "no-store");

    const signInAttempt = await get(server.base, "/api/auth/sign-in");
    assert.equal(signInAttempt.status, 302);
    assert.equal(signInAttempt.headers.get("location"), "/leave?sign-in=failed");
    assert.match(server.output(), /Leave days is not configured/);
  });

  it("serves the web app at /leave", async () => {
    const page = await get(server.base, "/leave");

    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="root"/);
  });
});

describe("server.mjs with leave configured", () => {
  const modelRequests = [];
  const scriptedReplies = [];
  let openai;
  let server;

  before(async () => {
    openai = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8").on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        modelRequests.push({ path: request.url, headers: request.headers, body });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: "resp_fake", object: "response", status: "completed", output: scriptedReplies.shift() ?? [] }));
      });
    }).listen(0, "127.0.0.1");
    await once(openai, "listening");

    server = await startServer({
      ...FULL_ENV,
      OPENAI_API_KEY: "fake-openai-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${openai.address().port}/v1`
    });
  });

  after(async () => {
    await server?.stop();
    openai?.closeAllConnections();
    openai?.close();
  });

  async function signInToServer() {
    const flow = await startSignIn(server.base);
    const callback = await get(server.base, approveSignIn(flow.location), {
      cookies: { northstar_signin: flow.flowCookie }
    });
    return { flow, callback, session: setCookies(callback).northstar_session?.value };
  }

  it("signs in and returns leave days, never cached, with nothing sensitive logged", async () => {
    const { flow, callback, session } = await signInToServer();
    assert.equal(flow.response.headers.get("cache-control"), "no-store");
    assert.equal(callback.headers.get("location"), "/leave");
    assert.equal(callback.headers.get("cache-control"), "no-store");

    const days = await leaveDays(server.base, session, `?asOfDate=${today()}`);
    assert.equal(days.status, 200);
    assert.equal(days.headers.get("cache-control"), "no-store");
    assert.deepEqual(await days.json(), { daysLeft: 13.625 });

    // Give the child's stdout a moment to arrive.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = server.output();
    assert.match(output, /"event":"leave_lookup","outcome":"returned"/);
    for (const value of [EMPLOYEE, "13.625", session, flow.flowCookie, FULL_ENV.ENTRA_CLIENT_SECRET,
      FULL_ENV.WORKDAY_CLIENT_SECRET, FULL_ENV.WORKDAY_REFRESH_TOKEN, "fake-entra-access-token", "fake-workday-access-token"]) {
      assert.ok(!output.includes(value), `server output holds a sensitive value starting "${value.slice(0, 6)}"`);
    }
  });

  it("sends no leave or sign-in data to OpenAI, even from a signed-in browser (TR-32)", async () => {
    const { session } = await signInToServer();
    assert.equal((await leaveDays(server.base, session, `?asOfDate=${today()}`)).status, 200);
    assert.equal(modelRequests.length, 0, "the leave flow itself must not call the model");

    scriptedReplies.push(
      [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup_order", arguments: '{"order_id":"NS-1002"}', status: "completed" }],
      [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "NS-1002 has shipped.", annotations: [] }] }]
    );
    const reply = await chat(server.base, "Where is order NS-1002?", `northstar_session=${session}`);

    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("cache-control"), "no-store");
    assert.equal((await reply.json()).reply, "NS-1002 has shipped.");
    assert.equal(modelRequests.length, 2);
    for (const request of modelRequests) {
      const sent = `${request.path} ${JSON.stringify(request.headers)} ${request.body}`;
      for (const value of [EMPLOYEE, "13.625", "daysLeft", session, "northstar_session", FULL_ENV.ENTRA_CLIENT_SECRET]) {
        assert.ok(!sent.includes(value), `a model request holds a value starting "${value.slice(0, 6)}"`);
      }
    }
  });

  it("refuses leave days without a session while chat stays open", async () => {
    const days = await leaveDays(server.base, null, `?asOfDate=${today()}&workEmail=${EMPLOYEE}`);

    assert.equal(days.status, 401);
    assert.deepEqual(Object.keys(await days.json()), ["error"]);
  });
});
