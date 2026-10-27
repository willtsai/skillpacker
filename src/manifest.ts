import { readFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { z } from "zod";
import { canonical, contained, relativePath } from "./files.js";
import type { Manifest, ManifestReader, PackageDefinition, Requirement, Source } from "./model.js";

export const nameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
const pathSchema = z.string().refine(value => {
  try { relativePath(value); return true; } catch { return false; }
}, "Must be a contained relative path");
const skillPathSchema = z.union([z.literal("."), pathSchema]);
export const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local"), path: z.string().min(1) }).strict(),
  z.object({
    type: z.literal("git"), url: z.string().min(1),
    subdir: pathSchema.optional(), ref: z.string().min(1).optional()
  }).strict()
]);
interface RawRequirement {
  source: z.infer<typeof sourceSchema>;
  version?: string;
  package?: {
    skills: string[];
    notices?: string[];
    dependencies?: Record<string, RawRequirement>;
  };
}

function requirementIssue(source: Source | RawRequirement["source"], range: string | undefined, plain: boolean): string | undefined {
  if (!plain && range === undefined) return "Manifest-aware dependencies require a version range";
  if (plain && source.type === "git" && !source.ref && range === undefined) {
    return "Plain Git dependencies require either an explicit ref or a version range";
  }
  if (plain && (source.type === "local" || source.ref) && range !== undefined) {
    return "Plain local or ref-pinned dependencies cannot declare a version range; omit version";
  }
}

const rangeSchema = z.string().refine(v => semver.validRange(v) !== null, "Invalid npm semver range");
const versionSchema = z.string().refine(v => semver.valid(v) !== null, "Invalid semantic version");
const dependencySchema: z.ZodType<RawRequirement> = z.lazy(() => z.object({
  source: sourceSchema,
  version: rangeSchema.optional(),
  package: z.object({
    skills: z.array(skillPathSchema).min(1),
    notices: z.array(pathSchema).optional(),
    dependencies: z.record(nameSchema, dependencySchema).optional()
  }).strict().optional()
}).strict().superRefine((value, context) => {
  const message = requirementIssue(value.source, value.version, value.package !== undefined);
  if (message) context.addIssue({ code: z.ZodIssueCode.custom, message });
}));
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: nameSchema,
  version: versionSchema,
  skills: z.array(skillPathSchema).default([]),
  dependencies: z.record(nameSchema, dependencySchema).default({}),
  notices: z.array(pathSchema).default([])
}).strict();

// Lockfiles store the normalized representation, including consumer-owned metadata.
const normalizedSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local"), path: z.string().min(1) }).strict(),
  z.object({
    type: z.literal("git"), url: z.string().min(1),
    subdir: z.union([z.literal(""), pathSchema]), ref: z.string().min(1).optional()
  }).strict()
]);
export const normalizedPackageSchema: z.ZodType<PackageDefinition> = z.lazy(() => z.object({
  skills: z.array(skillPathSchema).min(1),
  notices: z.array(pathSchema),
  dependencies: z.record(nameSchema, normalizedRequirementSchema)
}).strict());
export const normalizedRequirementSchema: z.ZodType<Requirement> = z.lazy(() => z.object({
  source: normalizedSourceSchema,
  range: rangeSchema.optional(),
  package: normalizedPackageSchema.optional()
}).strict().superRefine((value, context) => {
  const message = requirementIssue(value.source, value.range, value.package !== undefined);
  if (message) context.addIssue({ code: z.ZodIssueCode.custom, message });
}));
export const normalizedManifestSchema = z.object({
  name: nameSchema, version: versionSchema.nullable(),
  skills: z.array(skillPathSchema), notices: z.array(pathSchema),
  dependencies: z.record(nameSchema, normalizedRequirementSchema)
}).strict();

export function validateGitUrl(url: string): void {
  if (/^git@[^:\s]+:[^\s]+$/.test(url)) return;
  const parsed = new URL(url);
  if (!["https:", "ssh:", "file:"].includes(parsed.protocol) ||
      parsed.password || (parsed.protocol === "https:" && parsed.username)) {
    throw new Error("Git sources require HTTPS, SSH, or file URLs without embedded credentials");
  }
}

export function sourceKey(source: Source): string {
  return source.type === "local"
    ? `local:${source.path}`
    : `git:${source.url}#${source.subdir}@${source.ref ?? "(tags)"}`;
}

export function packageKey(definition?: PackageDefinition): string {
  return canonical(definition ?? null);
}

export function satisfiesVersion(version: string | null, range?: string): boolean {
  return range === undefined || (version !== null && semver.satisfies(version, range));
}

function normalizeDependencies(raw: Record<string, RawRequirement>, directory: string): Record<string, Requirement> {
  const dependencies: Record<string, Requirement> = {};
  for (const [name, requirement] of Object.entries(raw)) {
    const source = requirement.source;
    if (source.type === "git") validateGitUrl(source.url);
    dependencies[name] = {
      ...(requirement.version !== undefined ? { range: requirement.version } : {}),
      source: source.type === "local"
        ? { type: "local", path: path.resolve(directory, source.path) }
        : { ...source, subdir: source.subdir ?? "" },
      ...(requirement.package ? {
        package: {
          skills: requirement.package.skills,
          notices: requirement.package.notices ?? [],
          dependencies: normalizeDependencies(requirement.package.dependencies ?? {}, directory)
        }
      } : {})
    };
  }
  return dependencies;
}

export class JsonManifestReader implements ManifestReader {
  async read(directory: string): Promise<Manifest> {
    const filename = await contained(directory, "skillpacker.json");
    const raw = manifestSchema.parse(JSON.parse(await readFile(filename, "utf8")));
    return {
      name: raw.name, version: raw.version, skills: raw.skills,
      dependencies: normalizeDependencies(raw.dependencies, directory), notices: raw.notices
    };
  }
}
