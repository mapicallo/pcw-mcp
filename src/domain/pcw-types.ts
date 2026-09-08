export interface PcwProjectConfig {
  id?: string;
  name?: string;
}

export interface PcwPathConfig {
  path?: string;
}

export type PcwInventoryConfig = PcwPathConfig;
export type PcwSharedContextConfig = PcwPathConfig;

export interface PcwWorkstreamConfig {
  context?: PcwPathConfig;
  continuity?: PcwPathConfig;
}

export interface PcwConfig {
  version?: string | number;
  project?: PcwProjectConfig;
  inventory?: PcwInventoryConfig;
  shared_context?: Record<string, PcwSharedContextConfig>;
  workstreams?: Record<string, PcwWorkstreamConfig>;
}

export interface ResolvedWorkstream {
  name: string;
  config: PcwWorkstreamConfig;
}

export interface ResolvedSharedContext {
  name: string;
  config: PcwSharedContextConfig;
}
