// Builds the two release assets, and proves they hold the same files.
//
//   node cli/pack.js [OUT]        default OUT: cli/dist
//
// `dropbin.tgz` is what `npm pack` produced, renamed: install.sh unpacks it
// with tar, and `npm i -g ./dropbin.tgz` works on it too. `dropbin.zip` is the
// same tree, written by this package's own zip writer, because install.ps1
// unpacks with Expand-Archive — always there on Windows, unlike tar.
//
// Both names are fixed, with no version in them, so that
// releases/latest/download/dropbin.tgz keeps resolving as new versions land.
// Nothing here runs on a user's machine; it is the release recipe in CLAUDE.md,
// written down once so the two archives cannot drift apart.

import { execSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipDir } from "./src/zip.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] || join(here, "dist"));
const pkg = JSON.parse(await readFile(join(here, "package.json"), "utf8"));
// Through a shell on purpose: npm on Windows is a .cmd, which Node will not
// spawn directly, and execSync takes one command line rather than an argv.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// The tarball, straight from npm: whatever it ships is what a release holds.
const packed = JSON.parse(
  execSync(`${npm} pack --json --pack-destination "${out}"`, { cwd: here, encoding: "utf8" }),
)[0];
await rename(join(out, packed.filename), join(out, "dropbin.tgz"));

// The same files, laid out the way the tarball lays them out — a `package/`
// directory at the root — so both installers see one shape.
const stage = await mkdtemp(join(tmpdir(), "dropbin-pack-"));
try {
  const root = join(stage, "package");
  await mkdir(root);
  for (const f of new Set([...(pkg.files || []), "package.json", "LICENSE"])) {
    await cp(join(here, f), join(root, f), { recursive: true });
  }
  await zipDir(root, join(out, "dropbin.zip"));

  // npm decides what ships; this catches a `files` entry the copy above missed.
  const inZip = new Set(packed.files.map((f) => f.path));
  const listed = new Set();
  const seen = async (dir, base) => {
    const { readdir } = await import("node:fs/promises");
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = base ? base + "/" + e.name : e.name;
      if (e.isDirectory()) await seen(join(dir, e.name), rel);
      else listed.add(rel);
    }
  };
  await seen(root, "");
  const missing = [...inZip].filter((f) => !listed.has(f));
  const extra = [...listed].filter((f) => !inZip.has(f));
  if (missing.length || extra.length) {
    console.error("the two archives disagree:");
    if (missing.length) console.error("  only in the tarball:", missing.join(", "));
    if (extra.length) console.error("  only in the zip:", extra.join(", "));
    process.exit(1);
  }
  console.log(`dropbin ${pkg.version} — ${listed.size} files`);
  console.log(`  ${join(out, "dropbin.tgz")}`);
  console.log(`  ${join(out, "dropbin.zip")}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
