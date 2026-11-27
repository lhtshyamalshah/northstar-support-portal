// The leave settings and the files that ship them (TR-35, TR-36, TR-32).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { SIGN_IN_ENV, WORKDAY_ENV } from "./helpers/leave-fixtures.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const names = [...Object.keys(SIGN_IN_ENV), ...Object.keys(WORKDAY_ENV)];
const secrets = ["ENTRA_CLIENT_SECRET", "WORKDAY_CLIENT_SECRET", "WORKDAY_REFRESH_TOKEN"];
const localImports = (source) => [...source.matchAll(/(?:from\s+|import\()\s*["']\.\/([^"']+\.mjs)["']/g)].map((match) => match[1]);

describe("leave days settings (TR-35)", () => {
  it("lists every setting in .env.example with no value", () => {
    const lines = read(".env.example").split(/\r?\n/);

    for (const name of names) assert.ok(lines.includes(`${name}=`), name);
  });

  it("declares every setting as an optional integration field, secrets masked", () => {
    const fields = Object.assign({}, ...JSON.parse(read("integrations-config.json")).map((entry) => entry.configuration));

    for (const name of names) {
      assert.ok(fields[name], `${name} is declared`);
      assert.equal(fields[name].required, false, `${name} must not block the rest of the portal`);
      assert.equal(fields[name].type, secrets.includes(name) ? "PASSWORD" : "TEXT", name);
      assert.equal(fields[name].default, undefined, `${name} has no built-in value`);
    }
  });

  it("passes every setting through docker-compose without a value", () => {
    const lines = read("docker-compose.yml").split(/\r?\n/).map((line) => line.trim());

    for (const name of names) assert.ok(lines.includes(`- ${name}`), name);
  });

  it("reads only those settings, from the environment it is given", () => {
    const source = read("leave.mjs");
    const referenced = new Set(source.match(/\b(?:ENTRA|WORKDAY)_[A-Z_]+(?:ID|URI|URL|SECRET|TOKEN)\b/g));

    assert.deepEqual([...referenced].sort(), [...names].sort());
    assert.doesNotMatch(source, /process\.env/);
  });
});

describe("shipping the server (TR-36)", () => {
  it("copies every local server module into the runtime image", () => {
    const runtime = read("Dockerfile").split(/^FROM .* AS runtime$/m)[1];
    const modules = new Set(["server.mjs"]);
    for (const module of modules) {
      for (const imported of localImports(read(module))) modules.add(imported);
    }

    assert.ok(modules.has("leave.mjs"));
    for (const module of modules) assert.ok(runtime.includes(`/app/${module} `), module);
  });

  it("declares the sign-in library as a runtime dependency", () => {
    assert.ok(JSON.parse(read("package.json")).dependencies["@azure/msal-node"]);
    assert.ok(JSON.parse(read("package-lock.json")).packages["node_modules/@azure/msal-node"]);
  });
});

describe("keeping leave data away from the AI service (TR-32)", () => {
  it("gives the leave module no route to OpenAI or the chat governance", () => {
    const source = read("leave.mjs");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);

    assert.deepEqual(imports.sort(), ["@azure/msal-node", "express", "node:crypto"]);
  });
});
