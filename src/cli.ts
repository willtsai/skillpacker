#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { JsonManifestReader, nameSchema } from "./manifest.js";
import { Sources } from "./sources.js";
import { resolveLock, verifyLock, writeJson } from "./lock.js";
import { buildBundle } from "./bundle.js";

const help = `Skillpacker - resolve, lock, and bundle agent skills

Usage:
  skillpacker init [--name NAME]
  skillpacker resolve
  skillpacker validate
  skillpacker build --target portable|copilot|claude --out DIRECTORY

Options:
  --cwd DIRECTORY   Project directory (default: current directory)
  --help            Show help
  --version         Show the installed version

Resolve refreshes the complete graph and writes skillpacker.lock.json.
Validate and build are always frozen: they require and verify the lockfile.
Build refuses existing output directories. Git and Node.js >=20.19 are required.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string" }, name: { type: "string" }, target: { type: "string" },
      out: { type: "string" }, help: { type: "boolean" }, version: { type: "boolean" }
    }
  });
  if (values.version) {
    const metadata: unknown = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    if (!metadata || typeof metadata !== "object" || !("version" in metadata) || typeof metadata.version !== "string") {
      throw new Error("Installed package metadata has no valid version");
    }
    console.log(metadata.version);
    return;
  }
  if (values.help || !positionals.length) { console.log(help); return; }
  const [command] = positionals;
  if (positionals.length !== 1 || !["init", "resolve", "validate", "build"].includes(command!)) {
    throw new Error("Unknown command or extra arguments; use --help");
  }
  if ((values.name && command !== "init") || ((values.target || values.out) && command !== "build")) {
    throw new Error("Options do not apply to this command; use --help");
  }
  const root = path.resolve(values.cwd ?? ".");
  if (command === "init") {
    const name = nameSchema.parse(values.name ?? path.basename(root));
    await writeFile(path.join(root, "skillpacker.json"), JSON.stringify({
      schemaVersion: 1, name, version: "0.1.0", skills: [], dependencies: {}, notices: []
    }, null, 2) + "\n", { flag: "wx" });
    console.log("Created skillpacker.json. Add skill paths and dependencies, then run resolve.");
    return;
  }
  const reader = new JsonManifestReader();
  const sources = await Sources.create(reader);
  try {
    if (command === "resolve") {
      const lock = await resolveLock(root, reader, sources);
      await writeJson(path.join(root, "skillpacker.lock.json"), lock);
      console.log(`Locked ${Object.keys(lock.packages).length} dependency packages.`);
    } else if (command === "validate") {
      const packages = await verifyLock(root, reader, sources);
      console.log(`Verified ${packages.length} packages including the root.`);
    } else {
      const target = values.target ?? "portable";
      if (target !== "portable" && target !== "copilot" && target !== "claude") throw new Error(`Unknown target: ${target}`);
      if (!values.out) throw new Error("build requires --out DIRECTORY");
      const output = path.resolve(root, values.out);
      await buildBundle(root, output, target, reader, sources);
      console.log(`Built ${target} bundle at ${output}`);
    }
  } finally {
    await sources.close();
  }
}

main().catch((error: unknown) => {
  console.error(`skillpacker: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
