import fs from 'node:fs';
import path from 'node:path';

const FIXTURES_DIR = path.resolve(
  new URL('.', import.meta.url).pathname,
  '..',
  'fixtures',
);

export function loadFixture(source: string, filename: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, source, filename), 'utf-8');
}
