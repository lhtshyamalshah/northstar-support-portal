// Loaded with `node --import` ahead of server.mjs in the server integration test, so the
// child process cannot reach Microsoft, Workday or any other outside address.
import { createFakeUpstream } from "./fake-upstream.mjs";

const upstream = createFakeUpstream({ passThrough: globalThis.fetch });
globalThis.fetch = upstream.fetch;
