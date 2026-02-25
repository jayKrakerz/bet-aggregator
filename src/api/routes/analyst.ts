import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config.js';
import { sql } from '../../db/pool.js';

export const analystRoutes: FastifyPluginAsync = async (app) => {
  // POST /analyst/analyze — stream AI analysis as SSE via Ollama
  app.post('/analyze', async (request, reply) => {
    const body = request.body as { query?: string; matchId?: number };
    const query = body?.query?.trim();
    if (!query || query.length < 3 || query.length > 500) {
      return reply.status(400).send({ error: 'Query must be between 3 and 500 characters' });
    }

    const matchId = body.matchId ? Number(body.matchId) : null;

    // When matchId is provided, fetch that match's predictions; otherwise generic context
    const predictions = matchId
      ? await sql`
        SELECT
          ht.name as home_team,
          att.name as away_team,
          m.sport,
          to_char(m.game_date, 'YYYY-MM-DD') as game_date,
          m.game_time,
          p.pick_type,
          p.side,
          p.value,
          p.confidence,
          s.name as source_name,
          p.picker_name
        FROM predictions p
        JOIN matches m ON m.id = p.match_id
        JOIN teams ht ON ht.id = m.home_team_id
        JOIN teams att ON att.id = m.away_team_id
        JOIN sources s ON s.id = p.source_id
        WHERE m.id = ${matchId}
        ORDER BY s.name, p.pick_type
      `
      : await sql`
        SELECT
          ht.name as home_team,
          att.name as away_team,
          m.sport,
          to_char(m.game_date, 'YYYY-MM-DD') as game_date,
          m.game_time,
          p.pick_type,
          p.side,
          p.value,
          p.confidence,
          s.name as source_name,
          p.picker_name
        FROM predictions p
        JOIN matches m ON m.id = p.match_id
        JOIN teams ht ON ht.id = m.home_team_id
        JOIN teams att ON att.id = m.away_team_id
        JOIN sources s ON s.id = p.source_id
        WHERE m.game_date >= CURRENT_DATE
          AND m.game_date <= CURRENT_DATE + INTERVAL '3 days'
        ORDER BY m.game_date ASC, m.game_time ASC NULLS LAST
        LIMIT 50
      `;

    const firstPred = predictions[0] as Record<string, string> | undefined;

    // Build structured context the AI can actually reason about
    let predictionsContext: string;
    let matchContext: string;

    if (matchId && firstPred && predictions.length > 0) {
      matchContext = `for ${firstPred.home_team} vs ${firstPred.away_team} (${firstPred.sport}) on ${firstPred.game_date}`;

      // Build consensus summary by pick_type
      const byType: Record<string, Record<string, Array<{ source: string; picker: string; value: string | null; confidence: string | null }>>> = {};
      for (const p of predictions) {
        const type = String(p.pick_type);
        const side = String(p.side);
        if (!byType[type]) byType[type] = {};
        if (!byType[type][side]) byType[type][side] = [];
        byType[type][side].push({
          source: String(p.source_name),
          picker: String(p.picker_name),
          value: p.value != null ? String(p.value) : null,
          confidence: p.confidence ? String(p.confidence) : null,
        });
      }

      const uniqueSources = [...new Set(predictions.map(p => String(p.source_name)))];

      let summary = `MATCH: ${firstPred.home_team} (home) vs ${firstPred.away_team} (away)\n`;
      summary += `SPORT: ${firstPred.sport} | DATE: ${firstPred.game_date}${firstPred.game_time ? ' ' + firstPred.game_time : ''}\n`;
      summary += `TOTAL: ${predictions.length} predictions from ${uniqueSources.length} sources (${uniqueSources.join(', ')})\n\n`;
      summary += `=== CONSENSUS BREAKDOWN ===\n`;

      for (const [type, sides] of Object.entries(byType)) {
        const totalForType = Object.values(sides).reduce((n, arr) => n + arr.length, 0);
        summary += `\n${type.toUpperCase()} (${totalForType} picks):\n`;

        const sortedSides = Object.entries(sides).sort((a, b) => b[1].length - a[1].length);
        for (const [side, entries] of sortedSides) {
          const pct = Math.round((entries.length / totalForType) * 100);
          const avgValue = entries[0]?.value;
          const valuePart = avgValue ? ` ${avgValue}` : '';
          const confBreakdown = entries.filter(e => e.confidence).map(e => e.confidence);
          const confPart = confBreakdown.length ? ` | confidence levels: ${confBreakdown.join(', ')}` : '';
          summary += `  - ${side.toUpperCase()}${valuePart}: ${entries.length}/${totalForType} sources (${pct}%)${confPart}\n`;
          summary += `    Sources: ${entries.map(e => e.source + (e.picker !== e.source ? '/' + e.picker : '')).join(', ')}\n`;
        }
      }

      predictionsContext = summary;
    } else if (predictions.length > 0) {
      matchContext = 'from our aggregated sources';
      predictionsContext = predictions.map(p =>
        `${p.home_team} vs ${p.away_team} (${p.sport}, ${p.game_date}): ${p.source_name}/${p.picker_name} picks ${p.side} ${p.pick_type}${p.value ? ' ' + p.value : ''} (${p.confidence || 'no confidence'})`
      ).join('\n');
    } else {
      matchContext = 'from our aggregated sources';
      predictionsContext = 'No predictions currently available in the database.';
    }

    const systemPrompt = `You are an expert sports betting analyst for JA EdgeScore, a prediction aggregation platform that collects picks from ${matchId ? 'multiple professional tipster sources' : '17+ sources'}.

IMPORTANT: Base your analysis STRICTLY on the aggregated source data below. Do NOT fabricate stats, records, or injury info you don't have. When referencing data, cite the specific sources and consensus numbers.

=== SOURCE DATA ===
${predictionsContext}
=== END SOURCE DATA ===

Instructions:
1. **Consensus Summary**: Start with what the majority of sources agree on. Cite exact counts (e.g. "5 of 7 sources pick Lakers").
2. **Dissenting Views**: Note which sources disagree with the consensus and what they pick instead.
3. **Confidence Assessment**: If confidence levels are provided, highlight best_bet or high-confidence picks.
4. **Value Take**: Based on source agreement strength, assess whether this looks like a strong or weak consensus.
5. **Verdict**: Give a clear recommendation grounded in the data. State what the sources favor and how strong the agreement is.

Never invent statistics, win-loss records, or injury reports. If you don't have specific information, say so. Sports betting always involves risk.`;

    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      const ollamaRes = await fetch(`${config.OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.OLLAMA_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: query },
          ],
          stream: true,
        }),
      }) as unknown as { ok: boolean; status: number; text(): Promise<string>; body: AsyncIterable<Uint8Array> | null };

      if (!ollamaRes.ok) {
        const text = await ollamaRes.text();
        raw.write(`data: ${JSON.stringify({ error: `Ollama error (${ollamaRes.status}): ${text}` })}\n\n`);
        raw.end();
        return;
      }

      const reader = ollamaRes.body;
      if (!reader) {
        raw.write(`data: ${JSON.stringify({ error: 'No response body from Ollama' })}\n\n`);
        raw.end();
        return;
      }

      // Ollama streams newline-delimited JSON
      let buffer = '';
      for await (const chunk of reader as AsyncIterable<Uint8Array>) {
        buffer += new TextDecoder().decode(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.message?.content) {
              raw.write(`data: ${JSON.stringify({ text: data.message.content })}\n\n`);
            }
            if (data.done) {
              raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            }
          } catch {
            // skip malformed lines
          }
        }
      }

      // Handle any remaining buffer
      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer);
          if (data.message?.content) {
            raw.write(`data: ${JSON.stringify({ text: data.message.content })}\n\n`);
          }
        } catch {
          // skip
        }
      }

      raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const hint = message.includes('ECONNREFUSED')
        ? 'Ollama is not running. Start it with: ollama serve'
        : message;
      raw.write(`data: ${JSON.stringify({ error: hint })}\n\n`);
    }

    raw.end();
  });
};
