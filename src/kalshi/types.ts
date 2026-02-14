/**
 * Kalshi API Type Definitions
 *
 * Pricing convention:
 *   - Fields ending in `_dollars` are FixedPointDollars: string with up to 4 decimal places (e.g. "0.5600")
 *   - Fields like `balance` / `portfolio_value` on GET /portfolio/balance are integers in CENTS
 *   - Legacy integer cent fields (yes_bid, no_ask, etc.) are deprecated; use the _dollars variants
 *   - `_fp` suffixed fields are fixed-point string counts (e.g. "10.00" contracts)
 *
 * Conversion: 1 dollar = 100 cents = 10,000 centi-cents
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** US dollar amount as fixed-point decimal string, up to 4 decimal places. e.g. "0.5600" */
export type FixedPointDollars = string;

/** Fixed-point contract count string, up to 2 decimal places. e.g. "10.00" */
export type FixedPointCount = string;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type MarketStatus =
  | 'initialized'
  | 'inactive'
  | 'active'
  | 'closed'
  | 'determined'
  | 'disputed'
  | 'amended'
  | 'finalized';

/** Query-level status filter (subset used for GET /markets `status` param) */
export type MarketStatusFilter = 'unopened' | 'open' | 'paused' | 'closed' | 'settled';

export type MarketResult = 'yes' | 'no' | 'scalar' | '';

export type MarketType = 'binary' | 'scalar';

export type OrderSide = 'yes' | 'no';

export type OrderAction = 'buy' | 'sell';

export type OrderType = 'limit' | 'market';

export type OrderStatus = 'resting' | 'canceled' | 'executed';

export type TimeInForce = 'fill_or_kill' | 'good_till_canceled' | 'immediate_or_cancel';

export type SelfTradePreventionType = 'taker_at_cross' | 'maker';

export type StrikeType =
  | 'greater'
  | 'greater_or_equal'
  | 'less'
  | 'less_or_equal'
  | 'between'
  | 'functional'
  | 'custom'
  | 'structured';

export type MveFilter = 'only' | 'exclude';

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

export interface Market {
  ticker: string;
  event_ticker: string;
  market_type: MarketType;
  title: string;                          // deprecated but still present
  subtitle: string;                       // deprecated but still present
  yes_sub_title: string;
  no_sub_title: string;

  // Timestamps
  created_time: string;                   // ISO 8601
  updated_time: string;
  open_time: string;
  close_time: string;
  expected_expiration_time: string | null;
  expiration_time: string;                // deprecated
  latest_expiration_time: string;
  settlement_timer_seconds: number;
  settlement_ts: string | null;

  // Status
  status: MarketStatus;
  result: MarketResult;
  can_close_early: boolean;
  is_provisional: boolean;
  fractional_trading_enabled: boolean;

  // Pricing (FixedPointDollars -- the canonical format)
  yes_bid_dollars: FixedPointDollars;
  yes_ask_dollars: FixedPointDollars;
  no_bid_dollars: FixedPointDollars;
  no_ask_dollars: FixedPointDollars;
  last_price_dollars: FixedPointDollars;
  notional_value_dollars: FixedPointDollars;
  liquidity_dollars: FixedPointDollars;
  previous_yes_bid_dollars: FixedPointDollars;
  previous_yes_ask_dollars: FixedPointDollars;
  previous_price_dollars: FixedPointDollars;
  settlement_value_dollars: FixedPointDollars;

  // Volume (FixedPointCount)
  volume_fp: FixedPointCount;
  volume_24h_fp: FixedPointCount;
  open_interest_fp: FixedPointCount;

  // Strike / rules
  strike_type: StrikeType;
  floor_strike: number | null;
  cap_strike: number | null;
  functional_strike: string | null;
  custom_strike: Record<string, unknown> | null;
  rules_primary: string;
  rules_secondary: string;
  early_close_condition: string;

  // Pricing structure
  price_level_structure: string;
  price_ranges: unknown[];

  // Multivariate event
  mve_collection_ticker: string | null;
  mve_selected_legs: unknown[] | null;
  primary_participant_key: string | null;

  // Fee waiver
  fee_waiver_expiration_time: string | null;

  // Legacy cent fields (deprecated -- prefer _dollars variants)
  response_price_units?: string;
  expiration_value?: string;
}

// ---------------------------------------------------------------------------
// GET /markets
// ---------------------------------------------------------------------------

export interface GetMarketsParams {
  limit?: number;             // 1-1000, default 100
  cursor?: string;
  event_ticker?: string;      // comma-separated, max 10
  series_ticker?: string;
  tickers?: string;           // comma-separated market tickers
  status?: MarketStatusFilter;
  mve_filter?: MveFilter;
  min_created_ts?: number;    // Unix timestamp
  max_created_ts?: number;
  min_updated_ts?: number;
  min_close_ts?: number;
  max_close_ts?: number;
  min_settled_ts?: number;
  max_settled_ts?: number;
}

export interface GetMarketsResponse {
  cursor: string;
  markets: Market[];
}

// ---------------------------------------------------------------------------
// GET /portfolio/balance
// ---------------------------------------------------------------------------

export interface GetBalanceResponse {
  /** Available balance in CENTS (integer) */
  balance: number;
  /** Portfolio value in CENTS (integer) */
  portfolio_value: number;
  /** Unix timestamp of last update */
  updated_ts: number;
}

// ---------------------------------------------------------------------------
// POST /portfolio/orders  (Create Order)
// ---------------------------------------------------------------------------

export interface CreateOrderRequest {
  ticker: string;                                   // required
  side: OrderSide;                                  // required
  action: OrderAction;                              // required

  // Quantity -- provide count (int) or count_fp (string); if both, they must match
  count?: number;
  count_fp?: FixedPointCount;

  // Price -- provide yes_price/no_price (int cents 1-99) OR _dollars (string, 4 dp)
  yes_price?: number;
  no_price?: number;
  yes_price_dollars?: FixedPointDollars;
  no_price_dollars?: FixedPointDollars;

  // Optional order behavior
  client_order_id?: string;
  expiration_ts?: number;                           // Unix timestamp for GTD
  time_in_force?: TimeInForce;
  buy_max_cost?: number;                            // cents; triggers fill-or-kill
  post_only?: boolean;
  reduce_only?: boolean;
  self_trade_prevention_type?: SelfTradePreventionType;
  order_group_id?: string;
  cancel_order_on_pause?: boolean;
  subaccount?: number;                              // 0 = primary, 1-32 = sub
}

export interface Order {
  order_id: string;
  user_id: string;
  client_order_id: string;
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  type: OrderType;
  status: OrderStatus;

  // Price
  yes_price: number;
  no_price: number;
  yes_price_dollars: FixedPointDollars;
  no_price_dollars: FixedPointDollars;

  // Fill counts
  initial_count: number;
  initial_count_fp: FixedPointCount;
  fill_count: number;
  fill_count_fp: FixedPointCount;
  remaining_count: number;
  remaining_count_fp: FixedPointCount;

  // Fees & costs
  taker_fees: number;                     // cents
  maker_fees: number;                     // cents
  taker_fees_dollars: FixedPointDollars;
  maker_fees_dollars: FixedPointDollars;
  taker_fill_cost: number;               // cents
  maker_fill_cost: number;               // cents
  taker_fill_cost_dollars: FixedPointDollars;
  maker_fill_cost_dollars: FixedPointDollars;

  // Timestamps
  created_time: string;                   // ISO 8601
  expiration_time: string | null;
  last_update_time: string | null;

  // Flags
  cancel_order_on_pause: boolean;
  subaccount_number: number | null;
}

export interface CreateOrderResponse {
  order: Order;
}

// ---------------------------------------------------------------------------
// GET /portfolio/positions
// ---------------------------------------------------------------------------

export interface GetPositionsParams {
  cursor?: string;
  limit?: number;             // 1-1000, default 100
  count_filter?: string;      // comma-separated: "position", "total_traded"
  ticker?: string;
  event_ticker?: string;      // comma-separated, max 10
  subaccount?: number;
}

export interface MarketPosition {
  ticker: string;
  position: number;
  position_fp: FixedPointCount;
  total_traded: number;                    // cents
  total_traded_dollars: FixedPointDollars;
  market_exposure: number;                 // cents
  market_exposure_dollars: FixedPointDollars;
  realized_pnl: number;                   // cents
  realized_pnl_dollars: FixedPointDollars;
  resting_orders_count: number;
  fees_paid: number;                       // cents
  fees_paid_dollars: FixedPointDollars;
  last_updated_ts: string | null;
}

export interface EventPosition {
  event_ticker: string;
  total_cost: number;                      // cents
  total_cost_dollars: FixedPointDollars;
  total_cost_shares: number;
  total_cost_shares_fp: FixedPointCount;
  event_exposure: number;                  // cents
  event_exposure_dollars: FixedPointDollars;
  realized_pnl: number;                   // cents
  realized_pnl_dollars: FixedPointDollars;
  fees_paid: number;                       // cents
  fees_paid_dollars: FixedPointDollars;
}

export interface GetPositionsResponse {
  cursor?: string;
  market_positions: MarketPosition[];
  event_positions: EventPosition[];
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export interface KalshiErrorResponse {
  code: string;
  message: string;
  details?: unknown;
  service?: string;
}

// ---------------------------------------------------------------------------
// GET /events
// ---------------------------------------------------------------------------

export interface Event {
  event_ticker: string;
  series_ticker: string;
  title: string;
  category: string;
  markets: Market[];
}

export interface GetEventsParams {
  limit?: number;
  cursor?: string;
  status?: 'open' | 'closed' | 'settled';
  series_ticker?: string;
  with_nested_markets?: boolean;
}

export interface GetEventsResponse {
  cursor: string;
  events: Event[];
}

// ---------------------------------------------------------------------------
// GET /markets/:ticker/orderbook
// ---------------------------------------------------------------------------

export interface OrderbookLevel {
  price: number;    // cents
  quantity: number;
}

export interface GetOrderbookResponse {
  orderbook: {
    yes: Array<[number, number]>;  // [price_cents, quantity]
    no: Array<[number, number]>;
  };
}

// ---------------------------------------------------------------------------
// GET /portfolio/orders
// ---------------------------------------------------------------------------

export interface GetOrdersParams {
  ticker?: string;
  event_ticker?: string;
  status?: OrderStatus;
  limit?: number;
  cursor?: string;
}

export interface GetOrdersResponse {
  cursor?: string;
  orders: Order[];
}

// ---------------------------------------------------------------------------
// DELETE /portfolio/orders/:orderId
// ---------------------------------------------------------------------------

export interface CancelOrderResponse {
  order: Order;
  reduced_by?: number;
}

// ---------------------------------------------------------------------------
// GET /portfolio/fills
// ---------------------------------------------------------------------------

export interface Fill {
  trade_id: string;
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  count: number;
  count_fp: FixedPointCount;
  yes_price: number;
  no_price: number;
  yes_price_dollars: FixedPointDollars;
  no_price_dollars: FixedPointDollars;
  taker_fees: number;
  taker_fees_dollars: FixedPointDollars;
  created_time: string;
  is_taker: boolean;
  order_id: string;
}

export interface GetFillsParams {
  ticker?: string;
  order_id?: string;
  limit?: number;
  cursor?: string;
}

export interface GetFillsResponse {
  cursor?: string;
  fills: Fill[];
}
