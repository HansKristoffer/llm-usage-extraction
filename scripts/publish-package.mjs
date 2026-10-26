import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Retry only the verified artifact. Registry/network errors must not look like absence.
const { name, version } = JSON.parse(readFileSync(".artifacts/package.json", "utf8"));
const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, {
  signal: AbortSignal.timeout(15_000),
});
if (response.ok) {
  console.log(`${name}@${version} is already published; skipping`);
} else if (response.status === 404) {
  execFileSync(
    "npm",
    ["publish", ".artifacts/package.tgz", "--ignore-scripts", "--access", "public", "--provenance"],
    { stdio: "inherit" },
  );
} else {
  throw new Error(`Cannot check ${name}@${version}: registry HTTP ${response.status}`);
}
