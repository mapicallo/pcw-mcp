export type ContinuityConfiguration = {
  workstream: string;
  configuredPath: string;
};

export type ContinuitySnapshot = {
  workstream: string;
  configuredPath: string;
  absolutePath: string;
  sha256: string;
  content: string;
};

export type ContinuityUpdateInput = {
  requestedWorkstream: string;
  content: string;
  expectedSha256: string;
};

export type ContinuityUpdateResult = {
  workstream: string;
  configuredPath: string;
  absolutePath: string;
  previousSha256: string;
  newSha256: string;
  backupPath: string;
  updated: true;
};
