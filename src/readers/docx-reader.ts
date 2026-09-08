import mammoth from "mammoth";

import {
  assertReadableSourceFile,
  hasSupportedExtension
} from "./reader-validation.js";

const DOCX_EXTENSIONS = [".docx"] as const;
const UNSUPPORTED_DOCX_MESSAGE = "This reader only supports DOCX files";

export type DocxReadResult = {
  text: string;
  warnings: Awaited<ReturnType<typeof mammoth.extractRawText>>["messages"];
};

export function isDocxSourcePath(sourcePath: string): boolean {
  return hasSupportedExtension(sourcePath, DOCX_EXTENSIONS);
}

export async function readDocxFile(
  sourcePath: string
): Promise<DocxReadResult> {
  await assertReadableSourceFile(
    sourcePath,
    DOCX_EXTENSIONS,
    UNSUPPORTED_DOCX_MESSAGE
  );
  const result = await mammoth.extractRawText({ path: sourcePath });
  return { text: result.value, warnings: result.messages };
}
