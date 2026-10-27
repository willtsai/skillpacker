import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

export function relativePath(value: string): string {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value) ||
      value.split("/").some(p => p === ".." || p === "." || !p) ||
      /^[A-Za-z]:/.test(value)) {
    throw new Error(`Expected a contained relative path, got '${value}'`);
  }
  return value;
}

export async function contained(root: string, relative: string): Promise<string> {
  relativePath(relative);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`Symlinks are not supported: ${current}`);
    }
  }
  return current;
}

export async function filesUnder(root: string, relative: string): Promise<string[]> {
  const full = await contained(root, relative);
  const stat = await lstat(full);
  if (stat.isFile()) return [relative];
  if (!stat.isDirectory()) throw new Error(`Unsupported file type: ${full}`);
  const files: string[] = [];
  for (const entry of (await readdir(full)).sort()) {
    files.push(...await filesUnder(root, `${relative}/${entry}`));
  }
  return files;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function integrity(root: string, manifest: unknown, files: string[]): Promise<string> {
  const hash = createHash("sha256").update(canonical(manifest));
  for (const name of [...new Set(files)].sort()) {
    const full = await contained(root, name);
    const bytes = await readFile(full);
    const executable = Boolean((await lstat(full)).mode & 0o111);
    hash.update(canonical([name, executable, bytes.length]));
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}
