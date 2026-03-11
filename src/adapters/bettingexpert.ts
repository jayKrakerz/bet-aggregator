import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * BettingExpert adapter (bettingexpert.com).
 *
 * Static HTML site with community tips displayed as cards. Each tip card
 * contains the match, prediction, tipster stats, and confidence rating.
 *
 * Expected structure:
 *   - Tip cards: `.tip-card`, `article[class*="tip"]`, `.tip-list-item`,
 *     `div[class*="tipCard"]`, `.prediction-card`
 *   - Match name: `.tip-card__match`, `.match-name`, `h3[class*="match"]`,
 *     `a[class*="match"]`, `.tip-event`
 *   - Prediction: `.tip-card__pick`, `.pick-text`, `span[class*="pick"]`,
 *     `.tip-selection`
 *   - Tipster: `.tip-card__user`, `.tipster-name`, `a[class*="user"]`,
 *     `.tip-author`
 *   - Stats: `.tip-card__stats`, `.tipster-stats`, `span[class*="yield"]`,
 *     `.tip-profit`
 *   - Confidence: `.tip-card__confidence`, `.confidence-rating`,
 *     `span[class*="confidence"]`, `.tip-rating`
 *   - Date/time: `.tip-card__time`, `.match-date`, `time`, `span[class*="date"]`
 *   - Sport: `.tip-card__sport`, `.sport-icon`, breadcrumb with "Football"
 */
export class BettingExpertAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'bettingexpert',
    name: 'BettingExpert',
    baseUrl: 'https://www.bettingexpert.com',
    fetchMethod: 'browser',
    paths: {
      football: '/tips',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  async browserActions(page: Page): Promise<void> {
    // BettingExpert is a Next.js SPA - wait for tip content to render
    await page.waitForSelector(
      'a[href*="/tips/"], [class*="tip"], [class*="prediction"]',
      { timeout: 15000 },
    ).catch(() => {});
    await page.waitForTimeout(3000);
    // Scroll to load more tips
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const gameDate = fetchedAt.toISOString().split('T')[0]!;

    // BettingExpert is a Next.js app with Tailwind CSS utility classes.
    // Tips are rendered as card-like divs or list items.
    // Look for links to individual tip pages: /tips/{id} or /football/tips/{id}
    // Each tip card typically contains: match name, pick/selection, tipster, odds

    // Strategy 1: Find tip card containers by looking for elements containing
    // both team names and betting selections
    const tipLinks = $('a[href*="/tips/"]').filter((_i, el) => {
      const text = $(el).text().trim();
      // Filter to links that look like they contain match/tip info
      return text.length > 10 && (
        text.includes(' - ') || text.includes(' vs ') || text.includes(' v ')
      );
    });

    const processedTips = new Set<string>();

    tipLinks.each((_i, el) => {
      const $link = $(el);
      const href = $link.attr('href') || '';
      if (processedTips.has(href)) return;
      processedTips.add(href);

      const linkText = $link.text().trim();
      const teams = this.parseMatchTeams(linkText);
      if (!teams) return;

      // Look for pick/selection text in surrounding context
      const $card = $link.closest('div, article, li').first();
      const cardText = $card.text().trim();

      // Try to extract selection from card text
      const side = this.pickToSide(cardText, teams.home, teams.away);
      if (!side) return;

      const pickType = this.inferPickType(cardText);
      let value: number | null = null;
      if (pickType === 'over_under') {
        value = this.parseTotalValue(cardText);
      }

      // Look for tipster name - usually a link to /user/ or /tipster/
      const tipsterEl = $card.find('a[href*="/user/"], a[href*="/tipster/"]');
      const tipsterName = tipsterEl.first().text().trim() || 'BettingExpert Community';

      // Look for odds value
      let confidence: Confidence | null = null;
      const oddsMatch = cardText.match(/(\d+\.\d{2})/);
      if (oddsMatch) {
        const odds = parseFloat(oddsMatch[1]!);
        if (odds >= 1.0 && odds <= 1.5) confidence = 'best_bet';
        else if (odds > 1.5 && odds <= 2.0) confidence = 'high';
        else if (odds > 2.0 && odds <= 3.0) confidence = 'medium';
        else confidence = 'low';
      }

      // Parse time
      const timeMatch = cardText.match(/(\d{1,2}:\d{2})/);
      const gameTime = timeMatch ? timeMatch[1]! : null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: teams.home,
        awayTeamRaw: teams.away,
        gameDate,
        gameTime,
        pickType,
        side,
        value,
        pickerName: tipsterName,
        confidence,
        reasoning: `Tipster: ${tipsterName}`,
        fetchedAt,
      });
    });

    // Strategy 2: If no tip links found, look for match elements in Next.js rendered content
    if (predictions.length === 0) {
      // Search all text nodes for "Team1 vs Team2" or "Team1 - Team2" patterns
      $('div, article, section').each((_i, el) => {
        const $el = $(el);
        // Skip if this element has many children (it's a container, not a tip)
        if ($el.children().length > 20) return;

        const text = $el.text().trim();
        if (text.length < 10 || text.length > 500) return;

        const teams = this.parseMatchTeams(text);
        if (!teams) return;

        const side = this.pickToSide(text, teams.home, teams.away);
        if (!side) return;

        const pickType = this.inferPickType(text);
        const dedupKey = `${teams.home}-${teams.away}-${side}`;
        if (processedTips.has(dedupKey)) return;
        processedTips.add(dedupKey);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: teams.home,
          awayTeamRaw: teams.away,
          gameDate,
          gameTime: null,
          pickType,
          side,
          value: null,
          pickerName: 'BettingExpert Community',
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  private parseMatchTeams(text: string): { home: string; away: string } | null {
    const separators = [' vs ', ' v ', ' - ', ' – ', ' @ '];
    for (const sep of separators) {
      const idx = text.toLowerCase().indexOf(sep.toLowerCase());
      if (idx > 0) {
        const home = text.slice(0, idx).trim();
        const away = text.slice(idx + sep.length).trim();
        if (home && away) return { home, away };
      }
    }
    return null;
  }

  private pickToSide(pickText: string, home: string, away: string): Side | null {
    const lower = pickText.toLowerCase();

    // Explicit 1X2
    if (lower === '1' || lower === 'home win' || lower === 'home') return 'home';
    if (lower === '2' || lower === 'away win' || lower === 'away') return 'away';
    if (lower === 'x' || lower === 'draw') return 'draw';

    // Over/under
    if (lower.includes('over')) return 'over';
    if (lower.includes('under')) return 'under';

    // Team name matching
    if (home && lower.includes(home.toLowerCase().slice(0, 5))) return 'home';
    if (away && lower.includes(away.toLowerCase().slice(0, 5))) return 'away';

    // Double chance
    if (lower.includes('1x') || lower.includes('home or draw')) return 'home';
    if (lower.includes('x2') || lower.includes('away or draw')) return 'away';

    return null;
  }

  private parseConfidenceValue(text: string): Confidence | null {
    if (!text) return null;

    // Numeric rating (e.g., "4/5", "8/10")
    const ratingMatch = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (ratingMatch) {
      const ratio = parseInt(ratingMatch[1]!, 10) / parseInt(ratingMatch[2]!, 10);
      if (ratio >= 0.8) return 'best_bet';
      if (ratio >= 0.6) return 'high';
      if (ratio >= 0.4) return 'medium';
      return 'low';
    }

    // Star count
    const stars = (text.match(/★|⭐/g) || []).length;
    if (stars >= 4) return 'best_bet';
    if (stars >= 3) return 'high';
    if (stars >= 2) return 'medium';
    if (stars >= 1) return 'low';

    // Percentage
    const pctMatch = text.match(/(\d+)%/);
    if (pctMatch) {
      const pct = parseInt(pctMatch[1]!, 10);
      if (pct >= 80) return 'best_bet';
      if (pct >= 65) return 'high';
      if (pct >= 50) return 'medium';
      return 'low';
    }

    return this.inferConfidence(text);
  }
}
