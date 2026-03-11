import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * SofaScore NBA adapter (sofascore.com/basketball).
 *
 * SofaScore is a Next.js SPA. Match data is rendered in the DOM after hydration.
 * The __NEXT_DATA__ script contains initialState but event arrays are not
 * directly accessible there.
 *
 * Actual page structure (2026 DOM):
 *   - Events grouped by league in `div[class*="pb_sm"]` containers
 *   - League identity: each section has an `a[href*="/basketball/tournament/..."]`
 *     link (e.g., "/basketball/tournament/usa/nba/132")
 *   - Event links: `a[class*="event-hl-"]` with href like
 *     `/basketball/match/home-team-away-team/slug#id:12345`
 *   - Inside each link: `bdi` elements in order: [time, status, homeTeam, awayTeam]
 *     - time: "HH:MM" format (e.g., "23:00")
 *     - status: "-" for scheduled, "FT" for finished
 *   - Home team: first team bdi (parent has `mb_2xs` class)
 *   - Away team: second team bdi
 *   - Full team names: extracted from href slug (e.g., "utah-jazz-golden-state-warriors")
 */
export class SofascoreNbaAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'sofascore-nba',
    name: 'SofaScore NBA',
    baseUrl: 'https://www.sofascore.com',
    fetchMethod: 'browser',
    paths: {
      nba: `/basketball/${new Date().toISOString().split('T')[0]}`,
    },
    cron: '0 0 9,15,21 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 8000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for event links to render after React hydration
    await page.waitForSelector('a[class*="event-hl-"]', {
      timeout: 15000,
    }).catch(() => {});
    await page.waitForTimeout(3000);
    // Scroll to load more events
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const todayStr = fetchedAt.toISOString().split('T')[0]!;

    // Find NBA league sections: div[class*="pb_sm"] containers that have
    // an a[href] link containing "/nba/" (tournament link)
    $('[class*="pb_sm"]').each((_i, section) => {
      const $section = $(section);

      // Check if this section is an NBA section
      const hasNbaLink = $section.find('a[href*="/nba/"]').length > 0;
      if (!hasNbaLink) return;

      // Process event links within this NBA section
      $section.find('a[class*="event-hl-"]').each((_j, el) => {
        const $el = $(el);
        const href = $el.attr('href') || '';
        if (!href.includes('/basketball/match/')) return;

        // Extract bdi elements: [time, status, homeTeam, awayTeam]
        const bdis: string[] = [];
        $el.find('bdi').each((_k, b) => {
          bdis.push($(b).text().trim());
        });
        if (bdis.length < 4) return;

        const timeStr = bdis[0]!;
        const status = bdis[1]!;
        const homeTeamShort = bdis[2]!;
        const awayTeamShort = bdis[3]!;

        // Only keep scheduled matches (status "-")
        if (status !== '-') return;

        // Extract full team names from URL slug
        const slugMatch = href.match(/\/match\/([^/]+)\//);
        const slug = slugMatch ? slugMatch[1]! : '';
        const { home, away } = this.extractTeamNames(slug, homeTeamShort, awayTeamShort);

        // Extract game time
        const timeMatch = timeStr.match(/(\d{1,2}:\d{2})/);
        const gameTime = timeMatch ? timeMatch[1]! : null;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate: todayStr,
          gameTime,
          pickType: 'moneyline',
          side: 'home' as Side,
          value: null,
          pickerName: 'SofaScore Listing',
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      });
    });

    return predictions;
  }

  /**
   * Extract full team names from the URL slug using short names as delimiters.
   *
   * Slug format: "home-team-away-team" (e.g., "utah-jazz-golden-state-warriors").
   * Short names from bdi: "Jazz" and "Warriors".
   *
   * Strategy: find the short name fragments in the slug to locate the split point.
   */
  private extractTeamNames(
    slug: string,
    homeShort: string,
    awayShort: string,
  ): { home: string; away: string } {
    if (!slug) {
      return { home: homeShort, away: awayShort };
    }

    // Convert short names to slug fragments
    const homeFrag = homeShort.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const awayFrag = awayShort.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    // Find the away team fragment in the slug — it should end the slug or
    // be near the end. We want the split to include the full city+name.
    const awayIdx = slug.indexOf(awayFrag);
    if (awayIdx > 0) {
      // The away team's full name starts at the beginning of a hyphen-separated word
      // before or at awayIdx. Find the last hyphen boundary before awayIdx that makes sense.
      // Look backwards from awayIdx to find the nearest hyphen
      let splitIdx = awayIdx;
      // Check if there's a city name before the away short name
      // by looking at the slug up to the away fragment
      const beforeAway = slug.substring(0, awayIdx);
      // The home team slug ends where the away team slug begins.
      // Find the split: it's at a hyphen that separates home from away.
      // The home fragment should be at the start or within the first part.
      const homeEnd = slug.indexOf(homeFrag);
      if (homeEnd >= 0) {
        // Home fragment found — the home team ends after homeFrag
        const homeFragEnd = homeEnd + homeFrag.length;
        // The away team starts after the home team (with a hyphen separator)
        if (homeFragEnd < awayIdx) {
          // There might be extra words between homeFrag and awayFrag
          // Split at the first hyphen after the home fragment
          splitIdx = homeFragEnd + 1;
        }
      }

      const homeSlug = slug.substring(0, splitIdx).replace(/-$/, '');
      const awaySlug = slug.substring(splitIdx).replace(/^-/, '');

      if (homeSlug && awaySlug) {
        return {
          home: this.slugToName(homeSlug),
          away: this.slugToName(awaySlug),
        };
      }
    }

    // Fallback: return short names as-is
    return { home: homeShort, away: awayShort };
  }

  /** Convert a slug like "golden-state-warriors" to "Golden State Warriors" */
  private slugToName(slug: string): string {
    return slug
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
}
