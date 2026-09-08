export type InventoryDocument = {
  configuredPath: string;
  absolutePath: string;
  sizeBytes: number;
  modifiedAt: string;
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
