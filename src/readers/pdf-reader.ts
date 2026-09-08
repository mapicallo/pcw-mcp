import { readFile } from "node:fs/promises";

import { PDFParse } from "pdf-parse";

import {
  assertReadableSourceFile,
  hasSupportedExtension
} from "./reader-validation.js";

const PDF_EXTENSIONS = [".pdf"] as const;
const UNSUPPORTED_PDF_MESSAGE = "This reader only supports PDF files";

export function isPdfSourcePath(sourcePath: string): boolean {
  return hasSupportedExtension(sourcePath, PDF_EXTENSIONS);
}

export async function readPdfFile(sourcePath: string): Promise<string> {
  await assertReadableSourceFile(
    sourcePath,
    PDF_EXTENSIONS,
    UNSUPPORTED_PDF_MESSAGE
  );
  const parser = new PDFParse({ data: await readFile(sourcePath) });

  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}
