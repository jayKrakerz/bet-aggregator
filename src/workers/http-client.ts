import { request } from 'undici';

export interface HttpResult {
  body: string;
  status: number;
}

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'BetAggregator/1.0 (research project)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

export async function fetchHttp(url: string): Promise<HttpResult> {
  const { statusCode, body } = await request(url, {
    method: 'GET',
    headers: DEFAULT_HEADERS,
    maxRedirections: 3,
    headersTimeout: 15000,
    bodyTimeout: 30000,
  });

  const text = await body.text();

  return {
    body: text,
    status: statusCode,
  };
}
