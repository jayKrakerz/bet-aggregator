import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * WinDrawWin adapter.
 *
 * Cloudflare-protected site with football predictions and statistical analysis.
 * Requires Playwright for browser rendering.
 *
 * Page structure (div-based):
 *   - `.ptleag` — league header with text like "ENGLAND CHAMPIONSHIP"
 *   - `.wdwtablest` — prediction table container
 *   - `.wttr` — match prediction row
 *     - `.wtteam > .wtmoblnk` — home/away team names (first = home, second = away)
 *     - `.wttd.wtprd` — prediction text ("Away Win", "Home Win", "Draw")
 *     - `.wttd.wtstk` — stake level ("Large", "Medium", "Small")
 *     - `.wttd.wtsc` — score prediction ("0-1")
 *     - `.wtfullpred > .predstake` — full text ("Large Stake On Away Win")
 *     - `.wtfullpred > .predscore` — score ("0-1")
 *     - `.wtocell a[data-odds]` — odds with data-home, data-away, data-odds attrs
 */
export class WinDrawWinAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'windrawwin',
    name: 'WinDrawWin',
    baseUrl: 'https://www.windrawwin.com',
    fetchMethod: 'browser',
    paths: { football: '/predictions/today/' },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('.wdwtablest, .wttr, .wtprd', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentLeague = '';

    // Walk all children of the content area to track league context
    // League headers are in `.ptleag` elements preceding `.wdwtablest` tables
    $('.ptleag, .wdwtablest').each((_i, el) => {
      const $el = $(el);

      // League header — use the link text or strip "Tips" suffix
      if ($el.hasClass('ptleag')) {
        const linkText = $el.find('a').first().text().trim();
        currentLeague = (linkText || $el.text().trim())
          .replace(/\s*Tips$/i, '')
          .trim();
        return;
      }

      // Prediction table — process all match rows within
      $el.find('.wttr').each((_j, rowEl) => {
        const $row = $(rowEl);

        // Extract teams from .wtteam > .wtmoblnk
        const teamEls = $row.find('.wtteam .wtmoblnk');
        if (teamEls.length < 2) return;

        const homeTeamRaw = $(teamEls[0]).text().trim();
        const awayTeamRaw = $(teamEls[1]).text().trim();
        if (!homeTeamRaw || !awayTeamRaw) return;

        // Extract prediction from .wtprd (compact) or .predstake (full)
        const predText = $row.find('.wtprd').first().text().trim()
          || $row.find('.predstake').first().text().trim();
        if (!predText) return;

        const side = this.parsePredSide(predText);
        if (!side) return;

        // Extract stake for confidence
        const stakeText = $row.find('.wtstk').first().text().trim()
          || this.extractStakeFromPredstake($row.find('.predstake').first().text().trim());
        const confidence = this.stakeToConfidence(stakeText);

        // Extract score prediction
        const scorePred = $row.find('.wtsc').first().text().trim()
          || $row.find('.predscore').first().text().trim();

        // Extract odds from data-odds attributes
        const odds: number[] = [];
        $row.find('.wtocell a[data-odds]').each((_k, oddsEl) => {
          const val = parseFloat($(oddsEl).attr('data-odds') || '');
          if (!isNaN(val) && val > 1) odds.push(val);
        });

        // Pick the relevant odds value
        let value: number | null = null;
        if (side === 'home' && odds[0]) value = odds[0];
        else if (side === 'draw' && odds[1]) value = odds[1];
        else if (side === 'away' && odds[2]) value = odds[2];

        const reasoning = [
          currentLeague,
          scorePred ? `Predicted: ${scorePred}` : '',
          stakeText ? `Stake: ${stakeText}` : '',
        ].filter(Boolean).join(' | ') || null;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: fetchedAt.toISOString().split('T')[0]!,
          gameTime: null,
          pickType: 'moneyline',
          side,
          value,
          pickerName: 'WinDrawWin',
          confidence,
          reasoning,
          fetchedAt,
        });
      });
    });

    return predictions;
  }

  private parsePredSide(text: string): Side | null {
    const lower = text.toLowerCase();
    if (lower.includes('home win') || lower === 'home' || lower === '1') return 'home';
    if (lower.includes('away win') || lower === 'away' || lower === '2') return 'away';
    if (lower.includes('draw') || lower === 'x') return 'draw';
    return null;
  }

  private extractStakeFromPredstake(text: string): string {
    // "Large Stake On Away Win" → "Large"
    const match = text.match(/^(Large|Medium|Small)\s+Stake/i);
    return match ? match[1]! : '';
  }

  private stakeToConfidence(stake: string): Confidence | null {
    const lower = stake.toLowerCase();
    if (lower === 'large') return 'best_bet';
    if (lower === 'medium') return 'medium';
    if (lower === 'small') return 'low';
    return null;
  }
}
