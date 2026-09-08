import { realpath } from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";

const PATH_ESCAPE_MESSAGE =
  "Resolved path escapes the configured PCW context root";

export class PcwPathError extends Error {
  constructor(message = PATH_ESCAPE_MESSAGE) {
    super(message);
    this.name = "PcwPathError";
  }
}

export function normalizeContextRoot(contextRoot: string): string {
  return resolve(contextRoot);
}

export function ensureInsideBase(
  basePath: string,
  candidatePath: string
): string {
  const normalizedBase = resolve(basePath);
  const normalizedCandidate = resolve(candidatePath);
  const relativePath = relative(normalizedBase, normalizedCandidate);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new PcwPathError();
  }

  return normalizedCandidate;
}

export function resolveConfiguredPath(
  contextRoot: string,
  configuredPath: string
): string {
  const normalizedRoot = normalizeContextRoot(contextRoot);
  const candidatePath = resolve(normalizedRoot, configuredPath);

  return ensureInsideBase(normalizedRoot, candidatePath);
}

export function resolveSourcePath(
  contextRoot: string,
  configuredSectionPath: string,
  sourcePath: string
): string {
  const normalizedRoot = normalizeContextRoot(contextRoot);
  const sectionPath = resolveConfiguredPath(
    normalizedRoot,
    configuredSectionPath
  );
  const candidatePath = resolve(sectionPath, sourcePath);

  ensureInsideBase(normalizedRoot, candidatePath);
  return ensureInsideBase(sectionPath, candidatePath);
}

export async function assertExistingPathInsideBase(
  basePath: string,
  candidatePath: string
): Promise<void> {
  ensureInsideBase(basePath, candidatePath);

  const [realBasePath, realCandidatePath] = await Promise.all([
    realpath(basePath),
    realpath(candidatePath)
  ]);

  ensureInsideBase(realBasePath, realCandidatePath);
}

export async function assertExistingSourcePath(
  contextRoot: string,
  configuredSectionPath: string,
  sourcePath: string
): Promise<void> {
  const normalizedRoot = normalizeContextRoot(contextRoot);
  const sectionPath = ensureInsideBase(
    normalizedRoot,
    configuredSectionPath
  );
  ensureInsideBase(sectionPath, sourcePath);

  const [realRootPath, realSectionPath, realSourcePath] =
    await Promise.all([
      realpath(normalizedRoot),
      realpath(sectionPath),
      realpath(sourcePath)
    ]);

  ensureInsideBase(realRootPath, realSectionPath);
  ensureInsideBase(realRootPath, realSourcePath);
  ensureInsideBase(realSectionPath, realSourcePath);
}
