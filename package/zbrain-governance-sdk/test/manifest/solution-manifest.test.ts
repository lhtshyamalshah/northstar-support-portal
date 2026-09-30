import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadSolutionManifest } from "../../src/index.js";

describe("solution manifest", () => {
  it("loads the complete solution manifest contract from JSON", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-manifest-"));
    const manifestPath = join(tempDir, "solution-manifest.json");
    const manifest = {
      agents: [],
      tools: [],
      capabilities: ["ticket.read"],
      resources: ["ticketing"]
    };

    try {
      await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
      await expect(loadSolutionManifest(manifestPath)).resolves.toEqual(manifest);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
