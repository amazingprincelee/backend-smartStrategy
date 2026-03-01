/**
 * MarketDataService.js
 * Fetches multi-timeframe OHLCV data from Binance REST API.
 * Supports Spot and Futures.  Uses in-memory TTL cache per (symbol, tf, market).
 *
 * Fallback chain when Binance is geo-blocked (403 / 451):
 *   1. Binance  — primary (all hosts)
 *   2. Gate.io  — direct REST, no CloudFront, globally accessible
 *   3. KuCoin   — direct REST, additional fallback
 *
 * Candle format returned: { timestamp, open, high, low, close, volume }
 */

import axios from 'axios';

// ─── Binance hosts ────────────────────────────────────────────────────────────

const BINANCE_SPOT_HOSTS = [
  'https://api.binance.com/api/v3',
  'https://api1.binance.com/api/v3',
  'https://api2.binance.com/api/v3',
  'https://api3.binance.com/api/v3',
];
const BINANCE_FUTURES_HOSTS = [
  'https://fapi.binance.com/fapi/v1',
];

const BINANCE_FUTURES = BINANCE_FUTURES_HOSTS[0];

// How many candles to fetch per timeframe (enough to warm all indicators)
const CANDLE_LIMITS = {
  '1m':  120,
  '5m':  120,
  '15m': 120,
  '1h':  260,  // covers EMA200 warmup
};

// Cache TTL per timeframe
const CACHE_TTL = {
  '1m':  55_000,
  '5m':  4  * 60_000,
  '15m': 14 * 60_000,
  '1h':  55 * 60_000,
};

const FUNDING_CACHE_TTL = 5 * 60_000;

const http = axios.create({ timeout: 15_000 });

// ─── Binance primary ──────────────────────────────────────────────────────────

async function fetchWithFallback(hosts, path, params) {
  let lastErr;
  for (const base of hosts) {
    try {
      return await http.get(`${base}${path}`, { params });
    } catch (err) {
      lastErr = err;
      const code = err.response?.status;
      if (code && code < 500) throw err; // 4xx → no point retrying other hosts
    }
  }
  throw lastErr;
}

function mapBinanceCandles(data) {
  return data.map(k => ({
    timestamp: k[0],
    open:      parseFloat(k[1]),
    high:      parseFloat(k[2]),
    low:       parseFloat(k[3]),
    close:     parseFloat(k[4]),
    volume:    parseFloat(k[5]),
  }));
}

// ─── Gate.io fallback (direct REST — no CloudFront) ───────────────────────────
// Supports: 1m 5m 15m 30m 1h 4h 8h 1d 7d 30d
// Spot limit: max 1000 candles per request
// Futures limit: max 1999 candles per request

const GATEIO_SPOT_URL    = 'https://api.gateio.ws/api/v4/spot/candlesticks';
const GATEIO_FUTURES_URL = 'https://api.gateio.ws/api/v4/futures/usdt/candlesticks';

// BTCUSDT → BTC_USDT
function toGateioSymbol(symbol) {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) + '_USDT' : symbol;
}

async function fetchFromGateio(symbol, timeframe, limit, marketType) {
  const pair = toGateioSymbol(symbol);

  let url, params;
  if (marketType === 'futures') {
    url    = GATEIO_FUTURES_URL;
    params = { contract: pair, interval: timeframe, limit };
  } else {
    url    = GATEIO_SPOT_URL;
    params = { currency_pair: pair, interval: timeframe, limit };
  }

  const { data } = await http.get(url, { params });

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Gate.io returned no candles for ${symbol} ${timeframe}`);
  }

  if (marketType === 'futures') {
    // Futures: array of objects { t, v, c, h, l, o }
    return data.map(k => ({
      timestamp: parseInt(k.t)   * 1000,
      open:      parseFloat(k.o),
      high:      parseFloat(k.h),
      low:       parseFloat(k.l),
      close:     parseFloat(k.c),
      volume:    parseFloat(k.v),
    }));
  }

  // Spot: array of arrays [timestamp_sec, vol_quote, close, high, low, open]
  return data.map(k => ({
    timestamp: parseInt(k[0])  * 1000,
    open:      parseFloat(k[5]),
    high:      parseFloat(k[3]),
    low:       parseFloat(k[4]),
    close:     parseFloat(k[2]),
    volume:    parseFloat(k[1]),
  }));
}

// ─── KuCoin fallback (direct REST) ───────────────────────────────────────────
// Symbol format: BTC-USDT, type: 1min/5min/15min/1hour

const KUCOIN_KLINES_URL = 'https://api.kucoin.com/api/v1/market/candles';

const KUCOIN_TF = {
  '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1hour',
};

function toKucoinSymbol(symbol) {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) + '-USDT' : symbol;
}

async function fetchFromKucoin(symbol, timeframe, limit) {
  const type = KUCOIN_TF[timeframe] ?? '1hour';
  const kcSymbol = toKucoinSymbol(symbol);

  // KuCoin doesn't accept a 'limit' param; use startAt/endAt window
  const endAt   = Math.floor(Date.now() / 1000);
  const tfSec   = { '1min': 60, '5min': 300, '15min': 900, '30min': 1800, '1hour': 3600 };
  const startAt = endAt - (limit * (tfSec[type] ?? 3600)) - 3600; // small buffer

  const { data } = await http.get(KUCOIN_KLINES_URL, {
    params: { type, symbol: kcSymbol, startAt, endAt },
  });

  if (data.code !== '200000' || !Array.isArray(data.data)) {
    throw new Error(`KuCoin error for ${symbol} ${timeframe}`);
  }

  // KuCoin returns newest-first: [timestamp_sec, open, close, high, low, volume, turnover]
  return data.data
    .reverse()
    .slice(0, limit)
    .map(k => ({
      timestamp: parseInt(k[0]) * 1000,
      open:      parseFloat(k[1]),
      high:      parseFloat(k[3]),
      low:       parseFloat(k[4]),
      close:     parseFloat(k[2]),
      volume:    parseFloat(k[5]),
    }));
}

// ─── Try all fallbacks in order ───────────────────────────────────────────────

async function fetchCandlesWithFallback(symbol, timeframe, limit, marketType) {
  const hosts = marketType === 'futures' ? BINANCE_FUTURES_HOSTS : BINANCE_SPOT_HOSTS;

  // 1. Binance
  try {
    const { data } = await fetchWithFallback(hosts, '/klines', { symbol, interval: timeframe, limit });
    return mapBinanceCandles(data);
  } catch (err) {
    const code = err.response?.status;
    if (code !== 403 && code !== 451) throw err; // non-geo error → propagate
    console.warn(`[MarketData] Binance geo-blocked (${code}), trying Gate.io…`);
  }

  // 2. Gate.io
  try {
    const candles = await fetchFromGateio(symbol, timeframe, limit, marketType);
    console.info(`[MarketData] Gate.io OK for ${symbol} ${timeframe}`);
    return candles;
  } catch (gErr) {
    console.warn(`[MarketData] Gate.io failed: ${gErr.message}, trying KuCoin…`);
  }

  // 3. KuCoin (spot only — futures not supported)
  if (marketType !== 'futures') {
    const candles = await fetchFromKucoin(symbol, timeframe, limit);
    console.info(`[MarketData] KuCoin OK for ${symbol} ${timeframe}`);
    return candles;
  }

  throw new Error(`All data sources failed for ${symbol} ${timeframe} (geo-blocked)`);
}

// ─── Service ─────────────────────────────────────────────────────────────────

class MarketDataService {
  constructor() {
    this._candleCache  = new Map();
    this._fundingCache = new Map();
    this._tickerCache  = new Map();
  }

  // ─── Candles ─────────────────────────────────────────────────────────────

  async fetchCandles(symbol, timeframe, marketType = 'spot', limit = null) {
    const key    = `${symbol}:${timeframe}:${marketType}`;
    const cached = this._candleCache.get(key);
    const ttl    = CACHE_TTL[timeframe] ?? 60_000;

    if (cached && Date.now() - cached.ts < ttl) return cached.candles;

    const lim     = limit ?? CANDLE_LIMITS[timeframe] ?? 120;
    const candles = await fetchCandlesWithFallback(symbol, timeframe, lim, marketType);

    this._candleCache.set(key, { candles, ts: Date.now() });
    return candles;
  }

  async fetchMultiTimeframe(symbol, marketType = 'spot') {
    const timeframes = ['1m', '5m', '15m', '1h'];
    const results    = await Promise.allSettled(
      timeframes.map(tf => this.fetchCandles(symbol, tf, marketType))
    );

    const out = {};
    timeframes.forEach((tf, i) => {
      out[tf] = results[i].status === 'fulfilled' ? results[i].value : [];
    });
    return out;
  }

  // ─── Ticker ──────────────────────────────────────────────────────────────

  async fetchTicker(symbol, marketType = 'spot') {
    const key    = `ticker:${symbol}:${marketType}`;
    const cached = this._tickerCache.get(key);
    if (cached && Date.now() - cached.ts < 30_000) return cached.data;

    const hosts = marketType === 'futures' ? BINANCE_FUTURES_HOSTS : BINANCE_SPOT_HOSTS;

    let ticker;
    try {
      const { data } = await fetchWithFallback(hosts, '/ticker/24hr', { symbol });
      ticker = {
        lastPrice:          parseFloat(data.lastPrice),
        priceChangePercent: parseFloat(data.priceChangePercent),
        volume:             parseFloat(data.volume),
        quoteVolume:        parseFloat(data.quoteVolume),
        high24h:            parseFloat(data.highPrice),
        low24h:             parseFloat(data.lowPrice),
      };
    } catch (err) {
      const code = err.response?.status;
      if (code !== 403 && code !== 451) throw err;

      // Fallback: Gate.io 24h ticker
      try {
        const pair = toGateioSymbol(symbol);
        const { data } = await http.get(`https://api.gateio.ws/api/v4/spot/tickers`, {
          params: { currency_pair: pair },
        });
        const t = Array.isArray(data) ? data[0] : data;
        ticker = {
          lastPrice:          parseFloat(t.last          ?? 0),
          priceChangePercent: parseFloat(t.change_percentage ?? 0),
          volume:             parseFloat(t.base_volume   ?? 0),
          quoteVolume:        parseFloat(t.quote_volume  ?? 0),
          high24h:            parseFloat(t.high_24h      ?? 0),
          low24h:             parseFloat(t.low_24h       ?? 0),
        };
      } catch {
        throw err; // propagate original error if Gate.io also fails
      }
    }

    this._tickerCache.set(key, { data: ticker, ts: Date.now() });
    return ticker;
  }

  // ─── Funding rate (futures only) ─────────────────────────────────────────

  async fetchFundingRate(symbol) {
    const cached = this._fundingCache.get(symbol);
    if (cached && Date.now() - cached.ts < FUNDING_CACHE_TTL) return cached.rate;

    try {
      const { data } = await http.get(`${BINANCE_FUTURES}/premiumIndex`, {
        params: { symbol },
      });
      const rate = parseFloat(data.lastFundingRate ?? 0);
      this._fundingCache.set(symbol, { rate, ts: Date.now() });
      return rate;
    } catch {
      return 0; // non-critical — return neutral funding rate on error
    }
  }

  // ─── Extended history (for AI training / backtesting) ────────────────────

  async fetchHistoricalCandles(symbol, timeframe = '1h', limit = 1000, marketType = 'spot') {
    return fetchCandlesWithFallback(symbol, timeframe, limit, marketType);
  }

  // ─── Cache management ─────────────────────────────────────────────────────

  clearCache(symbol = null) {
    if (symbol) {
      for (const key of this._candleCache.keys()) {
        if (key.startsWith(symbol)) this._candleCache.delete(key);
      }
    } else {
      this._candleCache.clear();
      this._tickerCache.clear();
      this._fundingCache.clear();
    }
  }
}

export default new MarketDataService();
