import { describe, it, expect } from 'vitest';
import { parseSoccer24Feed, toRawGameResults } from '../../src/results/soccer24-parser.js';

// Simulated Soccer24/Flashscore pipe-delimited feed data
const SAMPLE_FEED = [
  'SA÷1¬~ZA÷ENGLAND: Premier League¬ZEE÷dYlOSQOD¬ZB÷198¬',
  '~AA÷UBn9TqDs¬AD÷1740412800¬AB÷3¬AE÷Everton¬AF÷Manchester Utd¬AG÷0¬AH÷2¬WM÷EVE¬WN÷MNU¬',
  '~AA÷xYz12345¬AD÷1740416400¬AB÷3¬AE÷Arsenal¬AF÷Liverpool¬AG÷3¬AH÷1¬WM÷ARS¬WN÷LIV¬',
  '~AA÷live0001¬AD÷1740420000¬AB÷2¬AE÷Chelsea¬AF÷Tottenham¬AG÷1¬AH÷1¬', // In progress — should be skipped
  '~AA÷post0001¬AD÷1740423600¬AB÷9¬AE÷Newcastle¬AF÷Aston Villa¬AG÷0¬AH÷0¬', // Postponed
  '~ZA÷SPAIN: LaLiga¬ZEE÷abc12345¬ZB÷100¬',
  '~AA÷spn00001¬AD÷1740412800¬AB÷3¬AE÷Barcelona¬AF÷Real Madrid¬AG÷2¬AH÷2¬',
  '~AA÷notstart¬AD÷1740500000¬AB÷1¬AE÷Sevilla¬AF÷Valencia¬AG÷¬AH÷¬', // Not started — should be skipped
].join('');

describe('Soccer24 Parser', () => {
  describe('parseSoccer24Feed', () => {
    it('should parse finished matches', () => {
      const matches = parseSoccer24Feed(SAMPLE_FEED);
      const finished = matches.filter((m) => m.status === 'final');
      expect(finished).toHaveLength(3);
    });

    it('should extract correct team names and scores', () => {
      const matches = parseSoccer24Feed(SAMPLE_FEED);
      const everton = matches.find((m) => m.matchId === 'UBn9TqDs');
      expect(everton).toBeDefined();
      expect(everton!.homeTeam).toBe('Everton');
      expect(everton!.awayTeam).toBe('Manchester Utd');
      expect(everton!.homeScore).toBe(0);
      expect(everton!.awayScore).toBe(2);
      expect(everton!.status).toBe('final');
    });

    it('should parse draws correctly', () => {
      const matches = parseSoccer24Feed(SAMPLE_FEED);
      const clasico = matches.find((m) => m.matchId === 'spn00001');
      expect(clasico).toBeDefined();
      expect(clasico!.homeScore).toBe(2);
      expect(clasico!.awayScore).toBe(2);
    });

    it('should skip in-progress matches', () => {
      const matches = parseSoccer24Feed(SAMPLE_FEED);
      const live = matches.find((m) => m.matchId === 'live0001');
      expect(live).toBeUndefined();
    });

    it('should skip not-started matches', () => {
      const matches = parseSoccer24Feed(SAMPLE_FEED);
      const notStarted = matches.find((m) => m.matchId === 'notstart');
      expect(notStarted).toBeUndefined();
    });

    it('should parse postponed matches', () => {
      const matches = parseSoccer24Feed(SAMPLE_FEED);
      const postponed = matches.find((m) => m.matchId === 'post0001');
      expect(postponed).toBeDefined();
      expect(postponed!.status).toBe('postponed');
    });

    it('should compute gameDate from unix timestamp', () => {
      const matches = parseSoccer24Feed(SAMPLE_FEED);
      const everton = matches.find((m) => m.matchId === 'UBn9TqDs');
      // 1740412800 = 2025-02-24 in UTC
      expect(everton!.gameDate).toBe('2025-02-24');
    });
  });

  describe('toRawGameResults', () => {
    it('should convert to RawGameResult format', () => {
      const matches = parseSoccer24Feed(SAMPLE_FEED);
      const results = toRawGameResults(matches);

      expect(results.length).toBe(matches.length);
      for (const r of results) {
        expect(r.sport).toBe('football');
        expect(r.homeTeamName).toBeTruthy();
        expect(r.awayTeamName).toBeTruthy();
        expect(typeof r.homeScore).toBe('number');
        expect(typeof r.awayScore).toBe('number');
        expect(r.gameDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(['final', 'postponed', 'cancelled']).toContain(r.status);
      }
    });

    it('should preserve team names from feed', () => {
      const matches = parseSoccer24Feed(SAMPLE_FEED);
      const results = toRawGameResults(matches);
      const arsenal = results.find((r) => r.homeTeamName === 'Arsenal');
      expect(arsenal).toBeDefined();
      expect(arsenal!.awayTeamName).toBe('Liverpool');
      expect(arsenal!.homeScore).toBe(3);
      expect(arsenal!.awayScore).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('should handle empty feed', () => {
      expect(parseSoccer24Feed('')).toEqual([]);
    });

    it('should handle feed with only league headers', () => {
      const feed = '~ZA÷ENGLAND: Premier League¬ZEE÷abc¬~ZA÷SPAIN: LaLiga¬ZEE÷def¬';
      expect(parseSoccer24Feed(feed)).toEqual([]);
    });

    it('should handle match with missing scores', () => {
      const feed = '~AA÷test01¬AD÷1740412800¬AB÷3¬AE÷TeamA¬AF÷TeamB¬';
      expect(parseSoccer24Feed(feed)).toEqual([]);
    });

    it('should handle extra time status as final', () => {
      const feed = '~AA÷aet001¬AD÷1740412800¬AB÷4¬AE÷TeamA¬AF÷TeamB¬AG÷2¬AH÷1¬';
      const matches = parseSoccer24Feed(feed);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.status).toBe('final');
    });

    it('should handle penalties status as final', () => {
      const feed = '~AA÷pen001¬AD÷1740412800¬AB÷5¬AE÷TeamA¬AF÷TeamB¬AG÷1¬AH÷1¬';
      const matches = parseSoccer24Feed(feed);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.status).toBe('final');
    });

    it('should handle abandoned status as cancelled', () => {
      const feed = '~AA÷abd001¬AD÷1740412800¬AB÷11¬AE÷TeamA¬AF÷TeamB¬AG÷0¬AH÷0¬';
      const matches = parseSoccer24Feed(feed);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.status).toBe('cancelled');
    });
  });
});
