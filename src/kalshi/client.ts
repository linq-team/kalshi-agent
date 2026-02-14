/**
 * Kalshi REST API Client
 *
 * Base URLs:
 *   Production: https://api.elections.kalshi.com/trade-api/v2
 *   Demo:       https://demo-api.kalshi.co/trade-api/v2
 *
 * All request paths are relative to this base (e.g. "/markets", "/portfolio/balance").
 * The signing function receives the FULL path with /trade-api/v2 prefix.
 */

import { signRequest, type KalshiCredentials, loadPrivateKeyFromFile, loadPrivateKeyFromString } from './signing.js';
import type {
  GetMarketsParams,
  GetMarketsResponse,
  GetBalanceResponse,
  CreateOrderRequest,
  CreateOrderResponse,
  GetPositionsParams,
  GetPositionsResponse,
  GetEventsParams,
  GetEventsResponse,
  GetOrderbookResponse,
  GetOrdersParams,
  GetOrdersResponse,
  CancelOrderResponse,
  GetFillsParams,
  GetFillsResponse,
  Market,
  Order,
  Fill,
  MarketPosition,
  KalshiErrorResponse,
} from './types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface KalshiClientConfig {
  /** API key ID (UUID) */
  apiKeyId: string;

  /**
   * Provide EITHER a file path to the PEM private key OR the PEM string itself.
   * The client will auto-detect based on whether the value starts with "-----".
   */
  privateKey: string;

  /** Base URL without trailing slash. Defaults to production. */
  baseUrl?: string;

  /** Request timeout in ms. Defaults to 10_000. */
  timeoutMs?: number;
}

const PRODUCTION_BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const DEMO_BASE_URL = 'https://demo-api.kalshi.co/trade-api/v2';

export { PRODUCTION_BASE_URL, DEMO_BASE_URL };

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class KalshiApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: KalshiErrorResponse | string,
    public readonly path: string,
  ) {
    const msg = typeof body === 'string' ? body : `${body.code}: ${body.message}`;
    super(`Kalshi API ${status} on ${path}: ${msg}`);
    this.name = 'KalshiApiError';
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class KalshiClient {
  private readonly credentials: KalshiCredentials;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: KalshiClientConfig) {
    const isPemString = config.privateKey.trimStart().startsWith('-----');
    const privateKey = isPemString
      ? loadPrivateKeyFromString(config.privateKey)
      : loadPrivateKeyFromFile(config.privateKey);

    this.credentials = { apiKeyId: config.apiKeyId, privateKey };
    this.baseUrl = (config.baseUrl ?? PRODUCTION_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  // -----------------------------------------------------------------------
  // Low-level HTTP
  // -----------------------------------------------------------------------

  /**
   * Make an authenticated request to the Kalshi API.
   *
   * @param method   HTTP method
   * @param endpoint Relative path (e.g. "/markets" or "/portfolio/orders")
   * @param params   Query params (for GET) or undefined
   * @param body     JSON body (for POST/PUT/DELETE) or undefined
   */
  private async request<T>(
    method: string,
    endpoint: string,
    params?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
  ): Promise<T> {
    // Build the full URL
    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    // The path for signing MUST include /trade-api/v2 prefix.
    // Extract it from the URL pathname (which already has the prefix from baseUrl).
    const signingPath = url.pathname; // e.g. "/trade-api/v2/markets"
    const { headers: authHeaders } = signRequest(this.credentials, method.toUpperCase(), signingPath);

    const headers: Record<string, string> = {
      ...authHeaders,
      'Accept': 'application/json',
    };

    const fetchInit: RequestInit = {
      method: method.toUpperCase(),
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      fetchInit.body = JSON.stringify(body);
    }

    const res = await fetch(url.toString(), fetchInit);

    if (!res.ok) {
      let errorBody: KalshiErrorResponse | string;
      try {
        errorBody = (await res.json()) as KalshiErrorResponse;
      } catch {
        errorBody = await res.text();
      }
      throw new KalshiApiError(res.status, errorBody, endpoint);
    }

    return (await res.json()) as T;
  }

  // -----------------------------------------------------------------------
  // Markets
  // -----------------------------------------------------------------------

  /**
   * GET /markets
   *
   * Retrieve a paginated list of markets.
   * Pricing fields use FixedPointDollars (string, 4 dp).
   */
  async getMarkets(params?: GetMarketsParams): Promise<GetMarketsResponse> {
    return this.request<GetMarketsResponse>('GET', '/markets', params as Record<string, string | number | undefined>);
  }

  /**
   * GET /markets/:ticker
   *
   * Retrieve a single market by ticker.
   */
  async getMarket(ticker: string): Promise<{ market: Market }> {
    return this.request<{ market: Market }>('GET', `/markets/${encodeURIComponent(ticker)}`);
  }

  /**
   * Auto-paginate through all markets matching the given params.
   * Yields each market as it is fetched.
   */
  async *getMarketsAll(params?: Omit<GetMarketsParams, 'cursor'>): AsyncGenerator<Market> {
    let cursor: string | undefined;
    do {
      const res = await this.getMarkets({ ...params, cursor });
      for (const market of res.markets) {
        yield market;
      }
      cursor = res.cursor || undefined;
    } while (cursor);
  }

  // -----------------------------------------------------------------------
  // Portfolio: Balance
  // -----------------------------------------------------------------------

  /**
   * GET /portfolio/balance
   *
   * Returns balance and portfolio_value in CENTS (integer).
   * To convert: dollars = balance / 100
   */
  async getBalance(): Promise<GetBalanceResponse> {
    return this.request<GetBalanceResponse>('GET', '/portfolio/balance');
  }

  /**
   * Convenience: get balance as dollar amounts (floats).
   */
  async getBalanceDollars(): Promise<{ balance: number; portfolioValue: number }> {
    const raw = await this.getBalance();
    return {
      balance: raw.balance / 100,
      portfolioValue: raw.portfolio_value / 100,
    };
  }

  // -----------------------------------------------------------------------
  // Portfolio: Orders
  // -----------------------------------------------------------------------

  /**
   * POST /portfolio/orders
   *
   * Create a new order. Pricing via yes_price_dollars / no_price_dollars (FixedPointDollars)
   * is recommended over the legacy integer cent fields.
   *
   * Max 200,000 open resting orders per user.
   */
  async createOrder(order: CreateOrderRequest): Promise<CreateOrderResponse> {
    return this.request<CreateOrderResponse>('POST', '/portfolio/orders', undefined, order);
  }

  // -----------------------------------------------------------------------
  // Portfolio: Positions
  // -----------------------------------------------------------------------

  /**
   * GET /portfolio/positions
   *
   * Returns unsettled positions only (use /portfolio/settlements for settled).
   * Monetary fields come in both integer cent and FixedPointDollars variants.
   */
  async getPositions(params?: GetPositionsParams): Promise<GetPositionsResponse> {
    return this.request<GetPositionsResponse>('GET', '/portfolio/positions', params as Record<string, string | number | undefined>);
  }

  /**
   * Auto-paginate through all positions.
   */
  async getPositionsAll(params?: Omit<GetPositionsParams, 'cursor'>): Promise<GetPositionsResponse> {
    const allMarket: GetPositionsResponse['market_positions'] = [];
    const allEvent: GetPositionsResponse['event_positions'] = [];
    let cursor: string | undefined;

    do {
      const res = await this.getPositions({ ...params, cursor });
      allMarket.push(...res.market_positions);
      allEvent.push(...res.event_positions);
      cursor = res.cursor || undefined;
    } while (cursor);

    return { market_positions: allMarket, event_positions: allEvent };
  }

  // -----------------------------------------------------------------------
  // Events (for market search)
  // -----------------------------------------------------------------------

  /**
   * GET /events
   *
   * Fetch events with optional nested markets.
   */
  async getEvents(params?: GetEventsParams): Promise<GetEventsResponse> {
    return this.request<GetEventsResponse>('GET', '/events', params as Record<string, string | number | boolean | undefined>);
  }

  /**
   * Search markets by keyword. Fetches open events with nested markets
   * and scores results by term match relevance + volume.
   */
  async searchMarkets(query: string, limit: number = 20): Promise<Market[]> {
    console.log(`[kalshi] Searching markets for "${query}"`);

    const data = await this.getEvents({
      limit: 200,
      with_nested_markets: true,
      status: 'open',
    });

    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 0);
    const scored: Array<{ market: Market; score: number }> = [];

    for (const event of (data.events || [])) {
      const eventTitle = (event.title || '').toLowerCase();
      for (const m of (event.markets || [])) {
        const title = (m.title || '').toLowerCase();
        const subtitle = (m.subtitle || '').toLowerCase();
        const ticker = (m.ticker || '').toLowerCase();
        const combined = `${eventTitle} ${title} ${subtitle} ${ticker}`;

        const matchCount = queryTerms.filter(t => combined.includes(t)).length;
        if (matchCount === 0) continue;

        let score = matchCount / queryTerms.length;
        if (matchCount === queryTerms.length) score += 1;
        if (combined.includes(queryLower)) score += 1;

        scored.push({ market: m, score });
      }
    }

    const volumeOf = (m: Market): number => {
      return parseFloat(m.volume_fp || '0') || 0;
    };

    scored.sort((a, b) => b.score - a.score || volumeOf(b.market) - volumeOf(a.market));
    const results = scored.slice(0, limit).map(s => s.market);
    console.log(`[kalshi] Found ${results.length} matching markets`);
    return results;
  }

  // -----------------------------------------------------------------------
  // Orderbook
  // -----------------------------------------------------------------------

  /**
   * GET /markets/:ticker/orderbook
   *
   * Returns bid levels for yes and no sides.
   */
  async getOrderbook(ticker: string, depth: number = 10): Promise<{ ticker: string; yes: Array<{ price: number; quantity: number }>; no: Array<{ price: number; quantity: number }> }> {
    console.log(`[kalshi] Getting orderbook: ${ticker} (depth=${depth})`);
    const data = await this.request<GetOrderbookResponse>('GET', `/markets/${encodeURIComponent(ticker)}/orderbook`, { depth });
    const book = data.orderbook;

    const parseLevel = (arr: unknown): Array<{ price: number; quantity: number }> => {
      if (!Array.isArray(arr)) return [];
      return arr.map((level: [number, number]) => ({
        price: level[0],
        quantity: level[1],
      }));
    };

    return {
      ticker,
      yes: parseLevel(book.yes),
      no: parseLevel(book.no),
    };
  }

  // -----------------------------------------------------------------------
  // Orders (query + cancel)
  // -----------------------------------------------------------------------

  /**
   * GET /portfolio/orders
   *
   * Get orders with optional filters.
   */
  async getOrders(params?: GetOrdersParams): Promise<GetOrdersResponse> {
    return this.request<GetOrdersResponse>('GET', '/portfolio/orders', params as Record<string, string | number | undefined>);
  }

  /**
   * DELETE /portfolio/orders/:orderId
   *
   * Cancel a resting order.
   */
  async cancelOrder(orderId: string): Promise<CancelOrderResponse> {
    console.log(`[kalshi] Cancelling order: ${orderId}`);
    return this.request<CancelOrderResponse>('DELETE', `/portfolio/orders/${encodeURIComponent(orderId)}`);
  }

  // -----------------------------------------------------------------------
  // Fills
  // -----------------------------------------------------------------------

  /**
   * GET /portfolio/fills
   *
   * Get recent executed trades.
   */
  async getFills(params?: GetFillsParams): Promise<GetFillsResponse> {
    return this.request<GetFillsResponse>('GET', '/portfolio/fills', params as Record<string, string | number | undefined>);
  }

  // -----------------------------------------------------------------------
  // Portfolio (convenience)
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Trending (client-side sort by 24h volume)
  // -----------------------------------------------------------------------

  // Trending cache: { data, timestamp }. Refreshed every 5 minutes.
  private trendingCache: { data: (Market & { series_ticker: string })[]; ts: number } | null = null;
  private static TRENDING_TTL_MS = 5 * 60 * 1000;

  /**
   * Get trending markets by fetching open events and sorting by 24h volume.
   * Deduplicates by event (picks the highest-volume market per event).
   * Results are cached for 5 minutes.
   */
  async getTrendingMarkets(limit: number = 15): Promise<(Market & { series_ticker: string })[]> {
    // Return cached data if fresh
    if (this.trendingCache && Date.now() - this.trendingCache.ts < KalshiClient.TRENDING_TTL_MS) {
      console.log('[kalshi] Returning cached trending markets');
      return this.trendingCache.data.slice(0, limit);
    }

    console.log('[kalshi] Fetching trending markets (cache miss)');

    // Fetch events with nested markets (3 pages = ~600 events)
    const allEntries: Array<{ market: Market; series_ticker: string; vol24h: number }> = [];
    let cursor: string | undefined;
    let page = 0;

    do {
      const data = await this.getEvents({
        status: 'open',
        with_nested_markets: true,
        limit: 200,
        cursor,
      });

      for (const event of data.events) {
        for (const m of (event.markets || [])) {
          allEntries.push({
            market: m,
            series_ticker: event.series_ticker,
            vol24h: parseFloat(m.volume_24h_fp || '0') || 0,
          });
        }
      }

      cursor = data.cursor || undefined;
      page++;
    } while (cursor && page < 3);

    // Deduplicate: pick the highest vol24h market per event
    const byEvent = new Map<string, typeof allEntries[number]>();
    for (const entry of allEntries) {
      const key = entry.market.event_ticker;
      if (!byEvent.has(key) || entry.vol24h > byEvent.get(key)!.vol24h) {
        byEvent.set(key, entry);
      }
    }

    // Sort by 24h volume descending, cache the full list
    const sorted = [...byEvent.values()].sort((a, b) => b.vol24h - a.vol24h);
    const allResults = sorted.map(e => ({
      ...e.market,
      series_ticker: e.series_ticker,
    }));
    this.trendingCache = { data: allResults, ts: Date.now() };

    const results = allResults.slice(0, limit);
    console.log(`[kalshi] Got ${results.length} trending markets (from ${allEntries.length} total)`);
    return results;
  }

  /**
   * Fetch balance + positions in parallel. Returns dollar amounts.
   */
  async getPortfolio(): Promise<{
    balance: number;
    portfolioValue: number;
    positions: MarketPosition[];
  }> {
    console.log('[kalshi] Fetching portfolio');
    const [balanceData, positionsData] = await Promise.all([
      this.getBalance(),
      this.getPositionsAll(),
    ]);

    const balance = balanceData.balance / 100;
    const portfolioValue = balanceData.portfolio_value / 100;
    const positions = positionsData.market_positions;

    console.log(`[kalshi] Portfolio: $${balance.toFixed(2)}, ${positions.length} positions`);
    return { balance, portfolioValue, positions };
  }
}
