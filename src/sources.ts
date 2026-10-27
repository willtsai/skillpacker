import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, lstat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import semver from "semver";
import { canonical, contained } from "./files.js";
import { sourceKey, validateGitUrl } from "./manifest.js";
import type { Candidate, Manifest, ManifestReader, PackageSelection, Provider, Requirement, Source } from "./model.js";

function hasLocalDependency(dependencies: Record<string, Requirement>): boolean {
  return Object.values(dependencies).some(r => r.source.type === "local" ||
    (r.package !== undefined && hasLocalDependency(r.package.dependencies)));
}

const exec = promisify(execFile);
async function git(work: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec("git", [
    "-c", `core.hooksPath=${path.join(work, "hooks")}`, "-c", "core.autocrlf=false", "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always",
    "-c", "protocol.file.allow=always", ...args
  ], {
    cwd, env: {
      ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(work, "gitconfig")
    },
    timeout: 120_000, maxBuffer: 16 * 1024 * 1024
  });
  return stdout.trim();
}

export class Sources implements Provider {
  private readonly mirrors = new Map<string, string>();
  private readonly snapshots = new Map<string, Candidate>();
  private readonly listings = new Map<string, Candidate[]>();
  private constructor(private readonly work: string, private readonly reader: ManifestReader) {}

  static async create(reader: ManifestReader): Promise<Sources> {
    const work = await mkdtemp(path.join(tmpdir(), "skillpacker-"));
    const sources = new Sources(work, reader);
    try {
      // Git for Windows cannot read Node's os.devNull path as a config file.
      await writeFile(path.join(work, "gitconfig"), "");
      await mkdir(path.join(work, "hooks"));
      return sources;
    } catch (error) {
      await sources.close();
      throw error;
    }
  }

  async close(): Promise<void> { await rm(this.work, { recursive: true, force: true }); }

  private async mirror(url: string): Promise<string> {
    validateGitUrl(url);
    const existing = this.mirrors.get(url);
    if (existing) return existing;
    const destination = path.join(this.work, `mirror-${this.mirrors.size}`);
    await git(this.work, ["clone", "--mirror", "--", url, destination]);
    this.mirrors.set(url, destination);
    return destination;
  }

  async load(source: Source, revision?: string, selection?: PackageSelection, tag?: string): Promise<Candidate> {
    if (tag && (!semver.valid(tag) || source.type !== "git" || source.ref)) {
      throw new Error("A selected semver tag is only valid for tag-based Git resolution");
    }
    if (selection && source.type === "git" && !source.ref && !tag) {
      throw new Error(`Plain Git package '${selection.name}' needs a selected semver tag or an explicit ref`);
    }
    const read = async (directory: string): Promise<Manifest> => {
      if (selection) {
        return {
          name: selection.name, version: tag ? semver.valid(tag)! : null,
          ...selection.package
        };
      }
      const manifest = await this.reader.read(directory);
      if (manifest.version === null || !semver.valid(manifest.version)) {
        throw new Error(`Manifest-aware package '${manifest.name}' needs a semantic version`);
      }
      return manifest;
    };
    if (source.type === "local") {
      if ((await lstat(source.path)).isSymbolicLink()) throw new Error(`Local source is a symlink: ${source.path}`);
      return {
        source, directory: source.path, manifest: await read(source.path),
        ...(selection ? { package: selection.package } : {})
      };
    }
    const mirror = await this.mirror(source.url);
    const requested = revision ?? source.ref;
    if (!requested || requested.startsWith("-")) throw new Error("Git snapshot requires a valid ref or revision");
    const commit = await git(this.work, [`--git-dir=${mirror}`, "rev-parse", "--verify", "--end-of-options", `${requested}^{commit}`]);
    const key = canonical([sourceKey(source), commit, selection ?? null, tag ?? null]);
    const cached = this.snapshots.get(key);
    if (cached) return cached;
    const snapshot = path.join(this.work, `snapshot-${this.snapshots.size}`);
    await git(this.work, ["clone", "--no-checkout", "--", mirror, snapshot]);
    await git(this.work, ["checkout", "--detach", commit], snapshot);
    const directory = source.subdir ? await contained(snapshot, source.subdir) : snapshot;
    const manifest = await read(directory);
    if (!selection && hasLocalDependency(manifest.dependencies)) {
      throw new Error(`Git package '${manifest.name}' declares a local dependency; use explicit Git sources instead`);
    }
    const candidate = {
      source, revision: commit, directory, manifest,
      ...(tag ? { tag } : {}), ...(selection ? { package: selection.package } : {})
    };
    this.snapshots.set(key, candidate);
    return candidate;
  }

  async candidates(source: Source, selection?: PackageSelection): Promise<Candidate[]> {
    const key = canonical([sourceKey(source), selection ?? null]);
    const cached = this.listings.get(key);
    if (cached) return cached;
    let result: Candidate[];
    if (source.type === "local" || source.ref) {
      result = [await this.load(source, undefined, selection)];
    } else {
      const mirror = await this.mirror(source.url);
      const tags = (await git(this.work, [`--git-dir=${mirror}`, "tag", "--list"])).split("\n")
        .filter(tag => /^(v)?\d+\.\d+\.\d+/.test(tag) && semver.valid(tag));
      result = [];
      for (const tag of tags.sort()) {
        const candidate = await this.load(source, `refs/tags/${tag}`, selection, tag);
        if (candidate.manifest.version === null || !semver.eq(candidate.manifest.version, tag)) {
          throw new Error(`Tag ${tag} disagrees with manifest version ${candidate.manifest.version}`);
        }
        if (result.some(c => c.manifest.version === candidate.manifest.version)) {
          throw new Error(`Ambiguous tags for version ${candidate.manifest.version} in ${source.url}`);
        }
        result.push(candidate);
      }
    }
    this.listings.set(key, result);
    return result;
  }
}
