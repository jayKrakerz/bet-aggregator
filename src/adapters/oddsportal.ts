import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * OddsPortal adapter (oddsportal.com).
 *
 * SPA that renders match data via JavaScript. Requires browser rendering.
 *
 * Expected structure (after hydration):
 *   - Match rows: `div[class*="eventRow"]`, `.eventRow`, `div.event-row`,
 *     `tr[class*="deactivate"]`, `div[class*="match-row"]`
 *   - Home team: `a[class*="participant-home"]`, `.event-name a:first-child`,
 *     `span[class*="homeParticipant"]`
 *   - Away team: `a[class*="participant-away"]`, `.event-name a:last-child`,
 *     `span[class*="awayParticipant"]`
 *   - Time: `div[class*="event-time"]`, `.datet`, `span[class*="date"]`
 *   - Odds: `div[class*="odds-cell"]`, `p[class*="odds-value"]`,
 *     `span[class*="oddsValue"]`
 *   - Tournament: `a[class*="tournamentHeader"]`, `div[class*="category-name"]`
 */
export class OddsPortalAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'oddsportal',
    name: 'OddsPortal',
    baseUrl: 'https://www.oddsportal.com',
    fetchMethod: 'browser',
    paths: {
      football: '/matches/soccer/',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 8000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for match rows to render - OddsPortal uses React/Tailwind with eventRow divs
    await page.waitForSelector(
      'div[class*="eventRow"], [class*="border-black-borders"]',
      { timeout: 15000 },
    ).catch(() => {});
    await page.waitForTimeout(3000);
    // Scroll to trigger lazy loading
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentDate = fetchedAt.toISOString().split('T')[0]!;
    let currentTournament = '';

    // OddsPortal is a React SPA with Tailwind CSS
    // Match rows use class containing "eventRow"
    // Team names are in elements with class containing "participant-name" or nested links
    // The page title contains the date: "Next Football Matches: Today, 10 Mar 2026"
    const titleText = $('title').text();
    const titleDateMatch = titleText.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/);
    if (titleDateMatch) {
      const monthMap: Record<string, string> = {
        Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
        Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
      };
      const day = titleDateMatch[1]!.padStart(2, '0');
      const month = monthMap[titleDateMatch[2]!] || '01';
      const year = titleDateMatch[3]!;
      currentDate = `${year}-${month}-${day}`;
    }

    // Find all elements - OddsPortal renders match data in divs
    // Look for links containing team name patterns: /football/COUNTRY/LEAGUE/TEAM-TEAM/
    const matchLinks = $('a[href*="/football/"]').filter((_i, el) => {
      const href = $(el).attr('href') || '';
      // Match links typically have format: /football/country/league/team1-team2/ID/
      return /\/football\/[^/]+\/[^/]+\/[^/]+-[^/]+\//.test(href);
    });

    const processedMatches = new Set<string>();

    matchLinks.each((_i, el) => {
      const $link = $(el);
      const href = $link.attr('href') || '';

      // Skip if already processed
      if (processedMatches.has(href)) return;
      processedMatches.add(href);

      // Extract team names from link text or child elements
      const linkText = $link.text().trim();
      let home = '';
      let away = '';

      // Try to find participant name elements within or near the link
      const participantEls = $link.find('[class*="participant-name"], [class*="truncate"]');
      if (participantEls.length >= 2) {
        home = $(participantEls[0]).text().trim();
        away = $(participantEls[1]).text().trim();
      }

      // Fallback: parse "Home - Away" from link text
      if (!home || !away) {
        const teams = this.parseMatchTeams(linkText);
        if (teams) {
          home = teams.home;
          away = teams.away;
        }
      }

      // Fallback: parse from URL slug
      if (!home || !away) {
        const urlMatch = href.match(/\/([^/]+)-([^/]+)\/[^/]*$/);
        if (urlMatch) {
          // URL slugs use hyphens, convert to readable names
          home = urlMatch[1]!.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          away = urlMatch[2]!.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        }
      }

      if (!home || !away) return;

      // Try to find odds near this match link
      // OddsPortal renders odds in nearby sibling elements
      const $row = $link.closest('div[class*="eventRow"], div[class*="border-black-borders"], div[class*="flex"]').first();

      // Look for time
      let gameTime: string | null = null;
      const timeEl = $row.find('p, span, div').filter((_j, te) => {
        const t = $(te).text().trim();
        return /^\d{1,2}:\d{2}$/.test(t);
      });
      if (timeEl.length) {
        gameTime = timeEl.first().text().trim();
      }

      // Look for odds values (decimal numbers like 1.50, 3.40, etc.)
      const oddsValues: number[] = [];
      $row.find('p, span').each((_j, oe) => {
        const t = $(oe).text().trim();
        if (/^\d+\.\d{2}$/.test(t)) {
          const val = parseFloat(t);
          if (val >= 1.01 && val <= 100) {
            oddsValues.push(val);
          }
        }
      });

      let odds1 = 0;
      let oddsX = 0;
      let odds2 = 0;
      if (oddsValues.length >= 3) {
        odds1 = oddsValues[0]!;
        oddsX = oddsValues[1]!;
        odds2 = oddsValues[2]!;
      }

      const side = this.oddsToSide(odds1, oddsX, odds2);
      const confidence = this.oddsToConfidence(odds1, oddsX, odds2);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: home,
        awayTeamRaw: away,
        gameDate: currentDate,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'OddsPortal Consensus',
        confidence,
        reasoning: odds1 > 0
          ? `Odds: ${odds1} / ${oddsX} / ${odds2}`
          : null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseMatchTeams(text: string): { home: string; away: string } | null {
    const separators = [' - ', ' – ', ' vs ', ' v '];
    for (const sep of separators) {
      const idx = text.indexOf(sep);
      if (idx > 0) {
        const home = text.slice(0, idx).trim();
        const away = text.slice(idx + sep.length).trim();
        if (home && away) return { home, away };
      }
    }
    return null;
  }

  private oddsToSide(odds1: number, oddsX: number, odds2: number): Side {
    const min = Math.min(
      odds1 > 0 ? odds1 : Infinity,
      oddsX > 0 ? oddsX : Infinity,
      odds2 > 0 ? odds2 : Infinity,
    );
    if (min === odds1) return 'home';
    if (min === odds2) return 'away';
    return 'draw';
  }

  private oddsToConfidence(odds1: number, oddsX: number, odds2: number): Confidence | null {
    const min = Math.min(
      odds1 > 0 ? odds1 : Infinity,
      oddsX > 0 ? oddsX : Infinity,
      odds2 > 0 ? odds2 : Infinity,
    );
    if (min === Infinity) return null;
    const impliedProb = (1 / min) * 100;
    if (impliedProb >= 75) return 'best_bet';
    if (impliedProb >= 60) return 'high';
    if (impliedProb >= 45) return 'medium';
    return 'low';
  }
}
