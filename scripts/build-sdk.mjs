// Installs (first time only) and builds the bundled governance package.
// It installs from inside the package folder: `npm --prefix <folder> install` can
// write this app into that package's own dependencies.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sdk = new URL("../package/zbrain-governance-sdk/", import.meta.url);
const run = (command) => execSync(command, { cwd: fileURLToPath(sdk), stdio: "inherit" });

if (!existsSync(new URL("node_modules/tsup", sdk))) {
  run("npm ci --engine-strict=false --no-audit --no-fund");
}
run("npm run build");
