
// A five-token heatmap call at 12h cadence uses at most half of the default
// 20-token daily budget; the remaining half is reserved for manual/retry work.
export const DEFAULT_REFRESH_MS = 12 * 60 * 60 * 1000;
// Binance publishes no open-interest WebSocket, so its REST endpoint is polled (weight 1 of 2 400 a minute). Every 5 s, not 2: a minute
// bar's close is then at most 5 s old, while each reading costs the reducer a copy of its 20 000-row window and shortens what that window
// holds (11 hours of Binance alone at 2 s). Its REST budget is its own (`binance-openInterest` in rest-retry.mts). Override with OI_POLL_MS.
export const DEFAULT_BINANCE_OI_POLL_MS = 5_000;
export const DAILY_PROVIDER_TOKEN_BUDGET = 20;
