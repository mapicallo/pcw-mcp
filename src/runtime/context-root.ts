export const DEFAULT_PCW_CONTEXT_ROOT = "C:\\rmms-context";

export type RuntimeEnvironment = {
  PCW_CONTEXT_ROOT?: string;
};

export function resolveRuntimeContextRoot(
  environment: RuntimeEnvironment
): string {
  return environment.PCW_CONTEXT_ROOT ?? DEFAULT_PCW_CONTEXT_ROOT;
}
