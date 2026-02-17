import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Predictz adapter.
 *
 * Cloudflare-protected site requiring browser rendering.
 *
 * Page structure (div-based, not tables):
 *   - `.pttable` — prediction table container
 *   - `.pttrnh.ptttl` — league header row with `.pttd.ptlg > h2 > a`
 *   - `.pttr.ptcnt` — match prediction row
 *     - `.pttd.ptmobh` — home team name (mobile)
 *     - `.pttd.ptmoba` — away team name (mobile)
 *     - `.pttd.ptgame > a` — "Home v Away" full match link
 *     - `.pttd.ptprd > .ptpredboxsml` — prediction text ("Home 2-0", "Away 0-1", "Draw 1-1")
 *     - `.pttd.ptodds > a[data-odds]` — odds with data-home, data-away, data-odds attrs
 */
export class PredictzAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'predictz',
    name: 'Predictz',
    baseUrl: 'https://www.predictz.com',
    fetchMethod: 'browser',
    paths: { football: '/predictions/today/' },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('.pttable, .pttr, .ptcnt', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentLeague = '';

    // League headers
    $('.pttrnh.ptttl').each((_i, el) => {
      const leagueText = $(el).find('.ptlg h2 a').text().trim()
        || $(el).find('.ptlg h2').text().trim()
        || $(el).find('.ptlg').text().trim();
      if (leagueText) currentLeague = leagueText;
    });

    // Match rows — each `.pttr.ptcnt` is one match
    let league = '';
    $('.pttable').children().each((_i, el) => {
      const $el = $(el);

      // Update league from header rows
      if ($el.hasClass('pttrnh') && $el.hasClass('ptttl')) {
        const leagueText = $el.find('.ptlg h2 a').text().trim()
          || $el.find('.ptlg h2').text().trim()
          || $el.find('.ptlg').text().trim();
        if (leagueText) league = leagueText;
        return;
      }

      if (!($el.hasClass('pttr') && $el.hasClass('ptcnt'))) return;

      // Extract teams
      const homeTeamRaw = $el.find('.ptmobh').first().text().trim();
      const awayTeamRaw = $el.find('.ptmoba').first().text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      // Extract prediction text: "Home 2-0", "Away 0-1", "Draw 1-1"
      const predText = $el.find('.ptpredboxsml').first().text().trim();
      if (!predText) return;

      const { side, scorePred } = this.parsePredText(predText);
      if (!side) return;

      // Extract odds from data-odds attributes
      const odds: number[] = [];
      $el.find('.ptodds a[data-odds]').each((_j, oddsEl) => {
        const val = parseFloat($(oddsEl).attr('data-odds') || '');
        if (!isNaN(val) && val > 1) odds.push(val);
      });

      // Pick the relevant odds value for the predicted side
      let value: number | null = null;
      if (side === 'home' && odds[0]) value = odds[0];
      else if (side === 'draw' && odds[1]) value = odds[1];
      else if (side === 'away' && odds[2]) value = odds[2];

      const reasoning = [league, scorePred ? `Predicted: ${scorePred}` : ''].filter(Boolean).join(' | ') || null;

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
        pickerName: 'Predictz',
        confidence: this.oddsToConfidence(value),
        reasoning,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parsePredText(text: string): { side: Side | null; scorePred: string } {
    const lower = text.toLowerCase();
    let side: Side | null = null;
    if (lower.startsWith('home')) side = 'home';
    else if (lower.startsWith('away')) side = 'away';
    else if (lower.startsWith('draw')) side = 'draw';

    // Extract score prediction (e.g. "2-0", "0-1", "1-1")
    const scoreMatch = text.match(/(\d+-\d+)/);
    const scorePred = scoreMatch ? scoreMatch[1]! : '';

    return { side, scorePred };
  }

  private oddsToConfidence(odds: number | null): Confidence | null {
    if (!odds) return null;
    if (odds <= 1.3) return 'best_bet';
    if (odds <= 1.7) return 'high';
    if (odds <= 2.5) return 'medium';
    return 'low';
  }
}
