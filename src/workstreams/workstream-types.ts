export type WorkstreamCreationMode = "continuity-only" | "with-context";

export type CreateWorkstreamInput = {
  name: string;
  mode?: WorkstreamCreationMode;
  initialObjective?: string;
};

export type CreateWorkstreamResult = {
  workstream: string;
  mode: WorkstreamCreationMode;
  continuityPath: string;
  contextPath: string | null;
  configBackupPath: string;
  created: true;
  initialContinuitySha256: string;
};
