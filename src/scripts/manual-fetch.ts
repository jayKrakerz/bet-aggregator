/**
 * Manually trigger a fetch + parse cycle for specific adapters.
 * Usage: npx tsx src/scripts/manual-fetch.ts [adapter:sport ...]
 * Default: runs all 6 fixed adapters for NBA
 */
import { getAdapter } from '../adapters/index.js';
import { fetchHttp } from '../workers/http-client.js';
import { fetchBrowser } from '../workers/browser-pool.js';
import { normalizeAndInsert } from '../pipeline/normalizer.js';
import { loadTeamAliases, getAliasCount } from '../pipeline/team-resolver.js';
import { logger } from '../utils/logger.js';

// Load team aliases before anything else
await loadTeamAliases();
console.log(`Loaded ${getAliasCount()} team aliases`);

const DEFAULT_TARGETS = [
  'dunkel-index:nba',
  'scores-and-odds:nba',
  'cbs-sports:nba',
  'bettingpros:nba',
  'dimers:nba',
  'covers-com:nba',
];

const targets = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_TARGETS;

for (const target of targets) {
  const [adapterId, sport] = target.split(':');
  if (!adapterId || !sport) {
    console.error(`Invalid target: ${target} (expected adapter:sport)`);
    continue;
  }

  try {
    const adapter = getAdapter(adapterId);
    const urlPath = adapter.config.paths[sport];
    if (!urlPath) {
      console.error(`${adapterId} has no path for sport: ${sport}`);
      continue;
    }

    const url = `${adapter.config.baseUrl}${urlPath}`;
    console.log(`\n=== ${adapterId}:${sport} ===`);
    console.log(`  URL: ${url}`);
    console.log(`  Method: ${adapter.config.fetchMethod}`);

    let html: string;
    if (adapter.config.fetchMethod === 'browser') {
      console.log('  Fetching with browser...');
      html = await fetchBrowser(url, adapter.browserActions?.bind(adapter));
    } else {
      console.log('  Fetching with HTTP...');
      const result = await fetchHttp(url);
      html = result.body;
      console.log(`  HTTP status: ${result.status}, size: ${html.length}`);
    }

    console.log(`  Response size: ${html.length} bytes`);
    console.log(`  First 100 chars: ${html.slice(0, 100)}`);

    // Parse
    const predictions = adapter.parse(html, sport, new Date());
    console.log(`  Parsed: ${predictions.length} predictions`);

    if (predictions.length > 0) {
      console.log(`  Sample: ${JSON.stringify(predictions[0])}`);

      // If adapter supports discoverUrls, check for sub-URLs
      if (adapter.discoverUrls) {
        const subUrls = adapter.discoverUrls(html, sport);
        console.log(`  Discovered ${subUrls.length} sub-URLs`);
        if (subUrls.length > 0) {
          console.log(`  Sub-URLs: ${subUrls.slice(0, 3).join(', ')}`);
          // Fetch and parse first sub-URL
          const subUrl = subUrls[0]!;
          console.log(`  Fetching sub-URL: ${subUrl}`);
          let subHtml: string;
          if (adapter.config.fetchMethod === 'browser') {
            subHtml = await fetchBrowser(subUrl, adapter.browserActions?.bind(adapter));
          } else {
            const subResult = await fetchHttp(subUrl);
            subHtml = subResult.body;
          }
          const subPreds = adapter.parse(subHtml, sport, new Date());
          console.log(`  Sub-URL parsed: ${subPreds.length} predictions`);
          if (subPreds.length > 0) {
            predictions.push(...subPreds);
          }
        }
      }

      // Insert to DB
      const inserted = await normalizeAndInsert(predictions);
      console.log(`  Inserted: ${inserted} predictions into DB`);
    }
  } catch (err: any) {
    console.error(`  ERROR: ${err.message}`);
  }
}

console.log('\nDone!');
process.exit(0);
