import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { canonical } from "./files.js";
import { inventory } from "./inventory.js";
import {
  nameSchema, normalizedManifestSchema, normalizedPackageSchema,
  packageKey, satisfiesVersion, sourceKey
} from "./manifest.js";
import { assertAcyclic, resolveGraph } from "./resolver.js";
import type { Candidate, Lockfile, ManifestReader } from "./model.js";
import { Sources } from "./sources.js";

const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local"), path: z.string() }).strict(),
  z.object({ type: z.literal("git"), url: z.string(), subdir: z.string(), ref: z.string().optional() }).strict()
]);
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const lockSchema = z.object({
  lockVersion: z.literal(1),
  root: z.object({ manifest: normalizedManifestSchema, integrity: hashSchema }).strict(),
  packages: z.record(nameSchema, z.object({
    source: sourceSchema, revision: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
    tag: z.string().min(1).optional(), package: normalizedPackageSchema.optional(),
    manifest: normalizedManifestSchema, integrity: hashSchema
  }).strict())
}).strict();

export async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(JSON.parse(canonical(value)), null, 2) + "\n", { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function resolveLock(root: string, reader: ManifestReader, sources: Sources): Promise<Lockfile> {
  const manifest = await reader.read(root);
  if (manifest.version === null) throw new Error("Root package requires a semantic version");
  const selected = await resolveGraph(manifest, sources);
  const lock: Lockfile = {
    lockVersion: 1, root: { manifest, integrity: (await inventory(root, manifest)).integrity },
    packages: {}
  };
  for (const name of Object.keys(selected).sort()) {
    const candidate = selected[name]!;
    lock.packages[name] = {
      source: candidate.source, ...(candidate.revision ? { revision: candidate.revision } : {}),
      ...(candidate.tag ? { tag: candidate.tag } : {}),
      ...(candidate.package ? { package: candidate.package } : {}),
      manifest: candidate.manifest, integrity: (await inventory(candidate.directory, candidate.manifest)).integrity
    };
  }
  return lock;
}

export async function verifyLock(root: string, reader: ManifestReader, sources: Sources): Promise<Candidate[]> {
  const lock = lockSchema.parse(JSON.parse(await readFile(path.join(root, "skillpacker.lock.json"), "utf8")));
  const manifest = await reader.read(root);
  if (manifest.version === null) throw new Error("Root package requires a semantic version");
  if (canonical(manifest) !== canonical(lock.root.manifest)) throw new Error("Root manifest changed; run skillpacker resolve");
  if ((await inventory(root, manifest)).integrity !== lock.root.integrity) throw new Error("Root content changed; run skillpacker resolve");
  const selected: Record<string, Candidate> = {};
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (entry.source.type === "git" && !entry.revision) throw new Error(`Missing locked revision: ${name}`);
    const candidate = await sources.load(entry.source, entry.revision,
      entry.package ? { name, package: entry.package } : undefined, entry.tag);
    if (candidate.manifest.name !== name || canonical(candidate.manifest) !== canonical(entry.manifest)) {
      throw new Error(`Locked manifest mismatch: ${name}`);
    }
    if ((await inventory(candidate.directory, candidate.manifest)).integrity !== entry.integrity) {
      throw new Error(`Integrity mismatch: ${name}`);
    }
    selected[name] = candidate;
  }
  const reached = new Set<string>();
  const visit = (current: typeof manifest): void => {
    for (const [name, requirement] of Object.entries(current.dependencies)) {
      const candidate = selected[name];
      if (!candidate || sourceKey(candidate.source) !== sourceKey(requirement.source) ||
          packageKey(candidate.package) !== packageKey(requirement.package) ||
          !satisfiesVersion(candidate.manifest.version, requirement.range)) {
        throw new Error(`Lock does not satisfy ${current.name} -> ${name}@${requirement.range ?? "(revision-only)"} or its packaging declaration`);
      }
      if (!reached.has(name)) { reached.add(name); visit(candidate.manifest); }
    }
  };
  visit(manifest);
  assertAcyclic(manifest, selected);
  if (reached.size !== Object.keys(selected).length) throw new Error("Lock contains unreachable packages");
  return [
    { source: { type: "local", path: root }, manifest, directory: root },
    ...Object.keys(selected).sort().map(name => selected[name]!)
  ];
}
