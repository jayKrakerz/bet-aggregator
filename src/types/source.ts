export interface Source {
  id: number;
  slug: string;
  name: string;
  baseUrl: string;
  fetchMethod: 'http' | 'browser';
  isActive: boolean;
  lastFetchedAt: Date | null;
  createdAt: Date;
}
