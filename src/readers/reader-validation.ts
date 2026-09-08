import { stat } from "node:fs/promises";
import { extname } from "node:path";

export function hasSupportedExtension(
  sourcePath: string,
  supportedExtensions: readonly string[]
): boolean {
  return supportedExtensions.includes(extname(sourcePath).toLowerCase());
}

export async function assertReadableSourceFile(
  sourcePath: string,
  supportedExtensions: readonly string[],
  unsupportedMessage: string
): Promise<void> {
  if (!hasSupportedExtension(sourcePath, supportedExtensions)) {
    throw new Error(unsupportedMessage);
  }

  const info = await stat(sourcePath);
  if (!info.isFile()) {
    throw new Error("Source is not a file");
  }
}
