import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Pack and install the actual consumer artifact. Keep those exact bytes for publishing.
const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "package-consumer-"));
const artifacts = resolve(".artifacts");
mkdirSync(artifacts, { recursive: true });
rmSync(join(artifacts, "package.tgz"), { force: true });
rmSync(join(artifacts, "package.json"), { force: true });

try {
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const files = new Set(packed.files.map(({ path }) => path));
  assert.ok(
    [...files].some((file) => /^readme\.md$/i.test(file)),
    "Package needs a README",
  );
  assert.ok(files.has("LICENSE"), "Package needs its declared license");
  for (const file of files) {
    assert.ok(!/\.test\.[cm]?[jt]s$|\.tsbuildinfo$|\.tgz$/.test(file), `Unwanted package file: ${file}`);
    assert.ok(!file.startsWith("test/") && !file.startsWith(".github/"), `Unwanted package file: ${file}`);
  }
  const targets = (value) => (typeof value === "string" ? [value] : Object.values(value).flatMap(targets));
  for (const file of targets(pkg.exports)) {
    assert.ok(files.has(file.slice(2)), `Missing export: ${file}`);
  }
  writeFileSync(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, packed.filename)],
    { cwd: temporary, stdio: "pipe", timeout: 120_000 },
  );
  // The source reads files through Bun's APIs, so a Bun consumer is the real one.
  const specifiers = Object.keys(pkg.exports).map((key) => pkg.name + (key === "." ? "" : key.slice(1)));
  const code = `for (const name of ${JSON.stringify(specifiers)}) await import(name); console.log('Verified package imports');`;
  execFileSync("bun", ["-e", code], {
    cwd: temporary,
    stdio: "inherit",
    timeout: 30_000,
  });
  copyFileSync(join(temporary, packed.filename), join(artifacts, "package.tgz"));
  writeFileSync(
    join(artifacts, "package.json"),
    `${JSON.stringify({ name: pkg.name, version: pkg.version })}\n`,
  );
  console.log(`Verified ${pkg.name}@${pkg.version}: ${files.size} files, ${specifiers.length} imports`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
