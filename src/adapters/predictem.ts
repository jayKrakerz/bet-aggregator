import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * PredictEm adapter.
 *
 * WordPress/Divi site (server-rendered). 2-step scraping:
 * 1. Index page: article.et_pb_post with h2.entry-title > a for article links
 * 2. Detail page: article body with pick recommendation in prose
 *
 * Title format: "{Away} vs {Home} Prediction: {subtitle}"
 * URL format: /nba/{away}-{home}-betting-prediction-{MM}-{DD}-{YYYY}/
 */
export class PredictEmAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'predictem',
    name: 'PredictEm',
    baseUrl: 'https://www.predictem.com',
    fetchMethod: 'http',
    paths: {
      nba: '/nba/',
      nfl: '/nfl/',
      mlb: '/mlb/',
      ncaab: '/college-basketball/',
      ncaaf: '/college-football/',
    },
    cron: '0 0 8,12,16,20 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  discoverUrls(html: string, _sport: string): string[] {
    const $ = this.load(html);
    const urls: string[] = [];
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const yyyy = today.getFullYear();
    const dateSlug = `${mm}-${dd}-${yyyy}`;

    $('article.et_pb_post h2.entry-title a').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      if (!href.includes('prediction') && !href.includes('pick')) return;
      if (!href.includes(dateSlug) && !href.includes(`${yyyy}`)) return;

      const fullUrl = href.startsWith('http') ? href : `${this.config.baseUrl}${href}`;
      if (!urls.includes(fullUrl)) urls.push(fullUrl);
    });

    return urls.slice(0, 15);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);

    // Detail page: has single article with entry-content or et_pb_post_content
    if (($('div.entry-content').length > 0 || $('div.et_pb_post_content').length > 0) && $('article.et_pb_post').length <= 1) {
      return this.parseDetailPage($, sport, fetchedAt);
    }

    // Index page: list articles
    return this.parseIndexPage($, sport, fetchedAt);
  }

  private parseIndexPage(
    $: ReturnType<typeof this.load>,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];

    $('article.et_pb_post').each((_i, el) => {
      const $article = $(el);
      const title = $article.find('h2.entry-title a').text().trim();
      const matchup = this.parseTitleMatchup(title);
      if (!matchup) return;

      const author = $article.find('p.post-meta span.author a').text().trim();
      const dateText = $article.find('p.post-meta span.published').text().trim();
      const gameDate = this.parsePubDate(dateText) || fetchedAt.toISOString().split('T')[0]!;
      const excerpt = $article.find('div.post-content-inner p').text().trim();

      // Try to extract spread from excerpt: "15.5-point favorite" or "8.5-point underdog"
      const spreadMatch = excerpt.match(/([\d.]+)-point/i);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchup.home,
        awayTeamRaw: matchup.away,
        gameDate,
        gameTime: null,
        pickType: spreadMatch ? 'spread' : 'moneyline',
        side: 'home',
        value: spreadMatch ? parseFloat(spreadMatch[1]!) : null,
        pickerName: author || 'PredictEm',
        confidence: null,
        reasoning: excerpt.slice(0, 300) || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseDetailPage(
    $: ReturnType<typeof this.load>,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];
    const title = $('h1').first().text().trim();
    const matchup = this.parseTitleMatchup(title);
    if (!matchup) return [];

    const author = $('p.post-meta span.author a').text().trim()
      || $('meta[name="author"]').attr('content')?.trim()
      || 'PredictEm';

    // Date from URL or meta
    const canonical = $('link[rel="canonical"]').attr('href') || '';
    const urlDateMatch = canonical.match(/(\d{2})-(\d{2})-(\d{4})\/?$/);
    const gameDate = urlDateMatch
      ? `${urlDateMatch[3]}-${urlDateMatch[1]}-${urlDateMatch[2]}`
      : fetchedAt.toISOString().split('T')[0]!;

    // Collect all body text — try both content container classes
    const bodyText = $('div.entry-content').text() || $('div.et_pb_post_content').text();

    // Look for pick patterns
    // "Take the Wizards +15.5" or "back the Magic -15.5" or "grab the Wizards at +15.5"
    const spreadPick = bodyText.match(/(?:take|back|like|pick|grab)\s+(?:the\s+)?(.+?)\s+(?:at\s+)?([-+][\d.]+)/i);
    if (spreadPick) {
      const side = this.teamToSide(spreadPick[1]!.trim(), matchup.home, matchup.away);
      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchup.home,
        awayTeamRaw: matchup.away,
        gameDate,
        gameTime: null,
        pickType: 'spread',
        side,
        value: parseFloat(spreadPick[2]!),
        pickerName: author,
        confidence: 'medium',
        reasoning: title,
        fetchedAt,
      });
    }

    // "Final Score: Team 118, Team 111" or "Predicted Score: ..."
    const scorePick = bodyText.match(/(?:Final Score|Predicted Score|Score Prediction)[:\s]+(.+?)\s+(\d+)[,\s]+(.+?)\s+(\d+)/i);
    if (scorePick && predictions.length === 0) {
      const team1 = scorePick[1]!.trim();
      const score1 = parseInt(scorePick[2]!, 10);
      const score2 = parseInt(scorePick[4]!, 10);
      const winner = score1 > score2 ? team1 : scorePick[3]!.trim();
      const side = this.teamToSide(winner, matchup.home, matchup.away);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchup.home,
        awayTeamRaw: matchup.away,
        gameDate,
        gameTime: null,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: author,
        confidence: 'medium',
        reasoning: `Predicted: ${scorePick[0]}`,
        fetchedAt,
      });
    }

    // Extract total value if mentioned: "opened at 222" or "Over 222.0"
    const totalMatch = bodyText.match(/(?:opened\s+at|total.*?at|(?:Over|Under)\s+)([\d.]+)/i);
    const totalValue = totalMatch ? parseFloat(totalMatch[1]!) : null;

    // Over/under: "over the total", "under the total", or "total has value" patterns
    if (bodyText.match(/(?:take|like|lean|pick)\s+(?:the\s+)?over/i) || bodyText.match(/(?:push|go)\s+(?:this\s+)?past\s+\d/i) || bodyText.match(/(?:the\s+over|over\s+\d[\d.]*)\s+has\s+value|lean(?:ing)?\s+(?:toward\s+)?(?:the\s+)?over/i)) {
      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchup.home,
        awayTeamRaw: matchup.away,
        gameDate,
        gameTime: null,
        pickType: 'over_under',
        side: 'over',
        value: totalValue,
        pickerName: author,
        confidence: 'medium',
        reasoning: title,
        fetchedAt,
      });
    } else if (bodyText.match(/(?:take|like|lean|pick)\s+(?:the\s+)?under/i) || bodyText.match(/(?:the\s+under|under\s+\d[\d.]*)\s+has\s+value|lean(?:ing)?\s+(?:toward\s+)?(?:the\s+)?under/i)) {
      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchup.home,
        awayTeamRaw: matchup.away,
        gameDate,
        gameTime: null,
        pickType: 'over_under',
        side: 'under',
        value: totalValue,
        pickerName: author,
        confidence: 'medium',
        reasoning: title,
        fetchedAt,
      });
    }

    return predictions;
  }

  private parseTitleMatchup(title: string): { home: string; away: string } | null {
    // "Wizards vs Magic Prediction:" or "Suns vs. Kings Pick:"
    const match = title.match(/^(.+?)\s+(?:vs\.?|at)\s+(.+?)(?:\s+Prediction|\s+Pick|\s+Betting|$)/i);
    if (!match) return null;
    return { away: match[1]!.trim(), home: match[2]!.trim() };
  }

  private parsePubDate(text: string): string | null {
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const match = text.match(/(\w{3})\s+(\d{1,2}),?\s+(\d{4})/);
    if (!match) return null;
    const m = months[match[1]!.toLowerCase()];
    if (!m) return null;
    return `${match[3]}-${m}-${match[2]!.padStart(2, '0')}`;
  }

  private teamToSide(pickTeam: string, home: string, away: string): Side {
    const pickLower = pickTeam.toLowerCase();
    const homeWords = home.toLowerCase().split(/\s+/);
    const awayWords = away.toLowerCase().split(/\s+/);
    if (awayWords.some(w => w.length > 2 && pickLower.includes(w))) return 'away';
    if (homeWords.some(w => w.length > 2 && pickLower.includes(w))) return 'home';
    return 'home';
  }
}
