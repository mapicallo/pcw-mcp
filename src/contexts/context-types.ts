export type CreateSharedContextInput = {
  name: string;
};

export type CreateSharedContextResult = {
  name: string;
  path: string;
  configBackupPath: string;
  created: true;
};

export type EnableWorkstreamContextInput = {
  name: string;
};

export type EnableWorkstreamContextResult = {
  workstream: string;
  contextPath: string;
  configBackupPath: string;
  created: true;
};
