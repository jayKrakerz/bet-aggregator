export interface SnapshotMeta {
  sourceId: string;
  sport: string;
  url: string;
  fetchedAt: string;
  fetchMethod: 'http' | 'browser';
  httpStatus: number | null;
  durationMs: number;
  sizeBytes: number;
  /** Absolute path to the saved HTML file */
  htmlPath: string;
}
