import { readFile } from "node:fs/promises";

import {
  assertReadableSourceFile,
  hasSupportedExtension
} from "./reader-validation.js";

export const TEXT_SOURCE_EXTENSIONS = [".md", ".txt"] as const;
const UNSUPPORTED_TEXT_MESSAGE =
  "This reader only supports Markdown (.md) and plain-text (.txt) sources";

export function isTextSourcePath(sourcePath: string): boolean {
  return hasSupportedExtension(sourcePath, TEXT_SOURCE_EXTENSIONS);
}

export async function readTextFile(sourcePath: string): Promise<string> {
  await assertReadableSourceFile(
    sourcePath,
    TEXT_SOURCE_EXTENSIONS,
    UNSUPPORTED_TEXT_MESSAGE
  );
  return readFile(sourcePath, "utf8");
}
