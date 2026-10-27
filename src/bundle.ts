import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { contained } from "./files.js";
import { inventory } from "./inventory.js";
import { verifyLock, writeJson } from "./lock.js";
import type { ManifestReader, Target } from "./model.js";
import { Sources } from "./sources.js";

async function physicalPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(await physicalPath(parent), path.basename(value));
  }
}

export async function buildBundle(
  root: string, output: string, target: Target, reader: ManifestReader, sources: Sources
): Promise<void> {
  const candidates = await verifyLock(root, reader, sources);
  const inventories = await Promise.all(candidates.map(c => inventory(c.directory, c.manifest)));
  const names = new Set<string>();
  for (const inv of inventories) {
    for (const skill of inv.skills) {
      if (names.has(skill.name)) throw new Error(`Skill name collision: ${skill.name}; aliases are not supported`);
      names.add(skill.name);
    }
  }
  if (!names.size) throw new Error("Bundle exports no skills");
  const destination = await physicalPath(path.resolve(output));
  for (const candidate of candidates) {
    for (const relative of [...candidate.manifest.skills, ...candidate.manifest.notices]) {
      const source = await realpath(relative === "." ? candidate.directory : await contained(candidate.directory, relative));
      if (destination === source || destination.startsWith(source + path.sep)) throw new Error("Output cannot be inside packaged resources");
    }
  }
  await mkdir(path.dirname(output), { recursive: true });
  // Refuse replacement rather than deleting an existing directory or following a link.
  try {
    await lstat(output);
    throw new Error(`Output already exists: ${output}; choose a new directory`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const stage = await mkdtemp(path.join(path.dirname(output), ".skillpacker-"));
  const copy = async (directory: string, file: string, destination: string): Promise<void> => {
    const source = await contained(directory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await chmod(destination, (await lstat(source)).mode & 0o111 ? 0o755 : 0o644);
  };
  try {
    const provenance = [];
    for (const [index, candidate] of candidates.entries()) {
      const inv = inventories[index]!;
      for (const skill of inv.skills) {
        const dest = path.join(stage, "skills", skill.name);
        for (const file of skill.files) {
          await copy(candidate.directory, file, path.join(dest, skill.path === "." ? file : file.slice(skill.path.length + 1)));
        }
        for (const file of inv.notices) {
          await copy(candidate.directory, file, path.join(dest, ".skillpacker", "notices", file));
        }
      }
      provenance.push({
        package: candidate.manifest.name, version: candidate.manifest.version,
        source: candidate.source, revision: candidate.revision ?? null, integrity: inv.integrity,
        metadataOrigin: candidate.package ? "consumer" : "manifest",
        ...(candidate.package ? { packaging: candidate.package } : {}),
        tag: candidate.tag ?? null,
        skills: inv.skills.map(s => s.name), notices: inv.notices
      });
    }
    const first = candidates[0]!.manifest;
    const plugin = { name: first.name, version: first.version, description: `Skill bundle: ${first.name}` };
    if (target !== "portable") {
      const file = target === "claude" ? ".claude-plugin/plugin.json" : "plugin.json";
      await mkdir(path.dirname(path.join(stage, file)), { recursive: true });
      await writeJson(path.join(stage, file), plugin);
    }
    await writeJson(path.join(stage, "skillpacker.provenance.json"), provenance);
    await writeFile(path.join(stage, "skillpacker.lock.json"), await readFile(path.join(root, "skillpacker.lock.json")));
    await rename(stage, output);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
