import { failStartup } from "../utils/index.js";
import type { AgentDefinition } from "./agent-defination.js";
import type { ToolDefinition } from "./tool-defination.js";
import fs from "fs/promises";

/**
 * The complete set of solution-level declarations published to the governance microservice.
 * Keep this contract data-only so it can be loaded from JSON and hashed
 * deterministically during runtime registration.
 */
export interface SolutionManifest {
  agents: readonly AgentDefinition[];
  tools: readonly ToolDefinition[];
  capabilities: readonly string[];
  resources: readonly string[];
}

/**
 * Reads and parses a solution manifest from disk.
 *
 * Startup failures go through `failStartup` so callers get the same logging and
 * exit behavior for missing paths and malformed/unreadable files.
 */
export async function loadSolutionManifest(manifestPath: string): Promise<SolutionManifest> {
  if (!manifestPath || manifestPath.trim().length === 0) {
    failStartup("manifestPath is required");
  }

  let solutionManifest: SolutionManifest;

  try {
    solutionManifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as SolutionManifest;
  } catch (error) {
    failStartup(`Unable to read governance manifest at ${manifestPath}`, error);
  }
  return solutionManifest;
}
