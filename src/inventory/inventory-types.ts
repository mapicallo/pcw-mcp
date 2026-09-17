export type InventoryDocument = {
  configuredPath: string;
  absolutePath: string;
  sizeBytes: number;
  modifiedAt: string;
  sha256: string;
  content: string;
};

export type InventorySection = {
  title: string;
  content: string;
};

export type InventorySearchResult = {
  document: InventoryDocument;
  matches: InventorySection[];
};

export type InventoryUpdateInput = {
  content: string;
  expectedSha256: string;
};

export type InventoryUpdateResult = {
  configuredPath: string;
  absolutePath: string;
  previousSha256: string;
  newSha256: string;
  backupPath: string;
  updated: true;
};
