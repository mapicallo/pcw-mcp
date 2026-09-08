import * as z from "zod/v4";

import type { PcwConfig } from "../domain/pcw-types.js";

const configuredPathSchema = z.string().min(1);

const pathConfigSchema = z.object({
  path: configuredPathSchema.optional()
});

const workstreamConfigSchema = z.object({
  context: pathConfigSchema.optional(),
  continuity: pathConfigSchema.optional()
});

export const pcwConfigSchema: z.ZodType<PcwConfig> = z.object({
  version: z.union([z.string(), z.number()]).optional(),
  project: z.object({
    id: z.string().optional(),
    name: z.string().optional()
  }).optional(),
  inventory: pathConfigSchema.optional(),
  shared_context: z.record(
    z.string(),
    pathConfigSchema
  ).optional(),
  workstreams: z.record(
    z.string(),
    workstreamConfigSchema
  ).optional()
});
