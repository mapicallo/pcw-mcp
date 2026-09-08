import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageMetadata: unknown = require("../package.json");

if (
  typeof packageMetadata !== "object" ||
  packageMetadata === null ||
  !("version" in packageMetadata) ||
  typeof packageMetadata.version !== "string"
) {
  throw new TypeError("package.json must define a string version");
}

export const PCW_SOFTWARE_VERSION = packageMetadata.version;
