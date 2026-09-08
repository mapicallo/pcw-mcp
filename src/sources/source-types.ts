export type SourceEntryType = "file" | "directory" | "other";

export type SourceEntry = {
  name: string;
  type: SourceEntryType;
  sizeBytes: number;
  modifiedAt: string;
};

export type SourceListing = {
  absolutePath: string;
  sources: SourceEntry[];
};

export type ResolvedSourceFile = {
  absolutePath: string;
  sizeBytes: number;
  modifiedAt: string;
};
