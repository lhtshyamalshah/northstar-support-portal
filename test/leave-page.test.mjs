// The leave days page and its link, tested without a browser or a new dependency: the JSX
// is compiled with the esbuild transform Vite already ships, then run with stand-ins for
// the browser. LeavePage gets a minimal useState/useEffect; main.jsx uses real React.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { transformWithEsbuild } from "vite";

const nodeRequire = createRequire(import.meta.url);
const { renderToStaticMarkup } = nodeRequire("react-dom/server");
const UNAVAILABLE = "Your leave days can’t be shown right now.";
const STORAGE_KEY = "northstar.leaveSignInStartedAt";

/** Compiles a source file to CommonJS and runs it with the given modules swapped in. */
async function loadModule(path, substitutes = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { code } = await transformWithEsbuild(source, path.split("/").pop(), { format: "cjs", jsx: "automatic" });
  const module = { exports: {} };
  const require = (name) => substitutes[name] ?? nodeRequire(name);
  new Function("require", "module", "exports", code)(require, module, module.exports);
  return module.exports;
}

let state;
let effects;
let LeavePage;

before(async () => {
  const hooks = {
    useState(initial) {
      if (state === undefined) state = initial;
      return [state, (next) => { state = next; }];
    },
    useEffect(effect) {
      effects.push(effect);
    }
  };
  LeavePage = (await loadModule("../src/LeavePage.jsx", { react: hooks })).default;
});

let browser;
let originalWindow;
let originalDocument;

beforeEach(() => {
  state = undefined;
  effects = [];
  const storage = new Map();
  browser = { search: "", assigned: [], storage };
  originalWindow = globalThis.window;
  originalDocument = globalThis.document;
  globalThis.document = { title: "" };
  globalThis.window = {
    location: {
      get search() { return browser.search; },
      assign: (url) => browser.assigned.push(url)
    },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    }
  };
});

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
});

const render = () => renderToStaticMarkup(LeavePage());
const settle = () => new Promise((resolve) => setImmediate(resolve));
const reply = (body, status = 200) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

/** Mounts the page against a scripted API and returns the markup once it settles. */
async function open(t, api) {
  const fetchMock = t.mock.method(globalThis, "fetch", api);
  effects = [];
  const loading = render();
  const cleanup = effects[0]();
  await settle();
  await settle();
  return { loading, markup: render(), requests: fetchMock.mock.calls.map((call) => call.arguments), cleanup };
}

const visibleText = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("leave days page", () => {
  it("shows loading, then only the number (FR-47, TR-26)", async (t) => {
    const { loading, markup, requests } = await open(t, reply({ daysLeft: 13.625 }));

    assert.equal(visibleText(loading), "Annual leave days left Loading…");
    assert.equal(visibleText(markup), "Annual leave days left 13.625");
    assert.doesNotMatch(markup, /<(a|button|input|form|select|nav)\b/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0][1].cache, "no-store");
  });

  for (const daysLeft of [0, -2, "12.50"]) {
    it(`shows ${JSON.stringify(daysLeft)} exactly as received (FR-52)`, async (t) => {
      const { markup } = await open(t, reply({ daysLeft }));

      assert.equal(visibleText(markup), `Annual leave days left ${daysLeft}`);
    });
  }

  for (const [zone, instant, localDay] of [
    ["Pacific/Kiritimati", "2026-11-27T12:00:00Z", "2026-11-28"],
    ["Pacific/Pago_Pago", "2026-11-27T05:00:00Z", "2026-11-26"],
    ["UTC", "2027-01-05T09:00:00Z", "2027-01-05"]
  ]) {
    it(`asks as of the local date in ${zone}, sending nothing else (TR-25)`, async (t) => {
      const originalZone = process.env.TZ;
      process.env.TZ = zone;
      t.mock.timers.enable({ apis: ["Date"], now: Date.parse(instant) });
      try {
        const { requests } = await open(t, reply({ daysLeft: 1 }));

        assert.equal(requests[0][0], `/api/leave-days?asOfDate=${localDay}`);
      } finally {
        if (originalZone === undefined) delete process.env.TZ;
        else process.env.TZ = originalZone;
      }
    });
  }

  it("sends a person without a session to the company sign-in (FR-51)", async (t) => {
    const { markup } = await open(t, reply({ error: "Sign in to see your leave days." }, 401));

    assert.deepEqual(browser.assigned, ["/api/auth/sign-in"]);
    assert.ok(Number(browser.storage.get(STORAGE_KEY)) > 0);
    assert.equal(visibleText(markup), "Annual leave days left Loading…");
  });

  it("does not loop when the sign-in did not stick", async (t) => {
    browser.storage.set(STORAGE_KEY, String(Date.now() - 5_000));

    const { markup } = await open(t, reply({}, 401));

    assert.deepEqual(browser.assigned, []);
    assert.equal(visibleText(markup), `Annual leave days left ${UNAVAILABLE}`);
  });

  it("signs in again once an earlier attempt is old, as after the 8 hour session", async (t) => {
    browser.storage.set(STORAGE_KEY, String(Date.now() - 31_000));

    await open(t, reply({}, 401));

    assert.deepEqual(browser.assigned, ["/api/auth/sign-in"]);
  });

  it("forgets the sign-in attempt once the number is shown", async (t) => {
    browser.storage.set(STORAGE_KEY, String(Date.now()));

    await open(t, reply({ daysLeft: 3 }));

    assert.equal(browser.storage.has(STORAGE_KEY), false);
  });

  const failures = [
    ["a refused date", reply({ error: "Leave days are not available." }, 400)],
    ["no balance", reply({ error: "Leave days are not available." }, 404)],
    ["a Workday failure", reply({ daysLeft: 5 }, 502)],
    ["missing settings", reply({}, 503)],
    ["a server error page", reply("<html>500</html>", 500)],
    ["a reply that is not JSON", reply("<html></html>")],
    ["no connection", async () => { throw new TypeError("Failed to fetch"); }]
  ];

  for (const [label, api] of failures) {
    it(`shows the one plain message and no number after ${label}`, async (t) => {
      const { markup } = await open(t, api);

      assert.equal(visibleText(markup), `Annual leave days left ${UNAVAILABLE}`);
      assert.doesNotMatch(visibleText(markup), /\d/);
      assert.deepEqual(browser.assigned, []);
    });
  }

  it("shows the message after a failed sign-in, without asking for any number", async (t) => {
    browser.search = "?sign-in=failed";

    const { markup, requests } = await open(t, reply({ daysLeft: 5 }));

    assert.equal(visibleText(markup), `Annual leave days left ${UNAVAILABLE}`);
    assert.equal(requests.length, 0);
    assert.deepEqual(browser.assigned, []);
  });

  it("ignores the reply of an effect that was cleaned up, as under Strict Mode", async (t) => {
    t.mock.method(globalThis, "fetch", reply({}, 401));
    render();
    const [effect] = effects;

    effect()();
    effect();
    await settle();
    await settle();

    assert.deepEqual(browser.assigned, ["/api/auth/sign-in"]);
    assert.equal(visibleText(render()), "Annual leave days left Loading…");
  });
});

describe("routing and the leave days link", () => {
  const LeaveStandIn = () => "leave page stand-in";

  /** Runs main.jsx as if the browser were at `pathname` and returns what it renders. */
  async function renderAt(pathname) {
    let tree;
    globalThis.window = { location: { pathname } };
    globalThis.document = { body: {}, querySelector: () => ({}) };
    await loadModule("../src/main.jsx", {
      "react-dom/client": { createRoot: () => ({ render: (element) => { tree = element; } }) },
      "./LeavePage.jsx": { __esModule: true, default: LeaveStandIn }
    });
    return renderToStaticMarkup(tree);
  }

  it("shows every visitor of the support page a link to /leave (FR-53, TR-22)", async () => {
    const markup = await renderAt("/");

    assert.match(markup, /<a href="\/leave">Leave days<\/a>/);
    assert.match(markup, /How can we/);
  });

  it("opens the leave days page at /leave and nothing else", async () => {
    assert.equal(await renderAt("/leave"), "leave page stand-in");
  });

  it("keeps the order desk open at /admin", async () => {
    const markup = await renderAt("/admin");

    assert.match(markup, /Order <em>desk\.<\/em>/);
  });

  it("includes the leave page in the narrow screen layout (TR-20)", () => {
    const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
    const narrow = styles.slice(styles.indexOf("@media (max-width: 650px)"));

    assert.match(narrow, /\.leave-shell/);
    assert.match(narrow, /\.leave-card/);
  });
});
