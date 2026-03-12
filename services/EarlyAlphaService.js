/**
 * EarlyAlphaService
 *
 * Scans multiple data sources to detect early signs that a coin / token
 * might be about to pump — before it's obvious to the average trader.
 *
 * Sources:
 *  1. CoinGecko "new coins" endpoint — projects listed in the last 7 days
 *  2. CoinGecko "trending" endpoint — coins most searched in the last 24 h
 *  3. CoinGecko "coins/markets" — top-200 sorted by 24h volume change
 *  4. Whale accumulation proxy — unusual 1h price + volume spike on known pairs
 *
 * Everything is scored 0-100 and saved to the AlphaSignal collection.
 * Duplicate records (same symbol, same UTC day) are skipped.
 *
 * Runs every 5 minutes via cron in server.js.
 */

import AlphaSignal from '../models/AlphaSignal.js';
import marketDataService from './MarketDataService.js';

// ─── CoinGecko base (free, no key required) ──────────────────────────────────
const CG_BASE = 'https://api.coingecko.com/api/v3';

// Only bother storing signals above this minimum score
const MIN_SCORE = 40;

// Pairs we actively scan for whale / volume spikes on our exchange feed
const WATCHLIST_PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'ADAUSDT', 'AVAXUSDT', 'DOGEUSDT', 'MATICUSDT', 'LINKUSDT',
  'DOTUSDT', 'LTCUSDT', 'UNIUSDT', 'ATOMUSDT', 'NEARUSDT',
];

// ─── helpers ─────────────────────────────────────────────────────────────────
async function cgFetch(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${CG_BASE}${path}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`CoinGecko ${path} → HTTP ${res.status}`);
  return res.json();
}

// Friendly display names for common exchange IDs returned by CoinGecko tickers
const EXCHANGE_DISPLAY = {
  binance:           'Binance',
  gdax:              'Coinbase',
  kraken:            'Kraken',
  kucoin:            'KuCoin',
  okex:              'OKX',
  bybit_spot:        'Bybit',
  gateio:            'Gate.io',
  huobi:             'HTX',
  mexc:              'MEXC',
  bitfinex:          'Bitfinex',
  bitstamp:          'Bitstamp',
  bitget:            'Bitget',
  crypto_com:        'Crypto.com',
  upbit:             'Upbit',
  bithumb:           'Bithumb',
};

/**
 * Fetch the top exchanges (by converted USDT volume) for a given CoinGecko coin ID.
 * Returns up to `limit` exchange display names.
 * Falls back to [] on any error — exchange info is non-critical.
 */
async function fetchTopExchanges(cgId, limit = 3) {
  try {
    const data = await cgFetch(`/coins/${cgId}/tickers`, {
      depth: 'false',
      include_exchange_logo: 'false',
      order: 'volume_desc',
      page: 1,
    });
    const tickers = (data?.tickers || [])
      .filter(t => t.target === 'USDT' || t.target === 'USD' || t.target === 'BTC')
      .slice(0, limit * 2); // fetch more, dedupe by exchange

    const seen = new Set();
    const result = [];
    for (const t of tickers) {
      const exId = t.market?.identifier || '';
      if (seen.has(exId)) continue;
      seen.add(exId);
      const name = EXCHANGE_DISPLAY[exId] || t.market?.name || exId;
      if (name) result.push(name);
      if (result.length >= limit) break;
    }
    return result;
  } catch {
    return [];
  }
}

function todayKey(symbol) {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${symbol}`;
}

async function alreadySaved(symbol) {
  const key = todayKey(symbol);
  return !!(await AlphaSignal.exists({ dateKey: key }));
}

async function saveSignal({ symbol, name, exchange = 'coingecko', score, category, reasons, price, marketCap, volume24h, volumeChange, priceChange, priceChange1h, rank, exchanges = [] }) {
  if (score < MIN_SCORE) return null;
  if (await alreadySaved(symbol)) return null;

  return AlphaSignal.create({
    symbol,
    name: name || symbol,
    exchange,
    score: Math.round(score),
    category,
    reasons,
    price:         price         || null,
    marketCap:     marketCap     || null,
    volume24h:     volume24h     || null,
    volumeChange:  volumeChange  || null,
    priceChange:   priceChange   || null,
    priceChange1h: priceChange1h || null,
    rank:          rank          || null,
    exchanges,
    isActive: true,
    discoveredAt: new Date(),
    dateKey: todayKey(symbol),
  });
}

// Rate-limited exchange fetch: waits `delayMs` between each CG call
// to avoid hitting the free-tier rate limit (10–30 req/min).
async function fetchExchangesWithDelay(cgId, delayMs = 1200) {
  await new Promise(r => setTimeout(r, delayMs));
  return fetchTopExchanges(cgId);
}

// ─── Scanner 1: New listings (past 7 days, sorted by date_added desc) ────────
async function scanNewListings() {
  const results = [];
  try {
    const coins = await cgFetch('/coins/markets', {
      vs_currency: 'usd',
      order: 'id_asc',
      per_page: 250,
      page: 1,
      price_change_percentage: '1h,24h',
    });

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const c of coins) {
      if (!c.atl_date) continue;
      const atlDate = new Date(c.atl_date).getTime();
      if (atlDate < sevenDaysAgo) continue;

      let score = 55;
      const reasons = ['New coin detected (ATL date < 7 days ago)'];

      const pc24 = c.price_change_percentage_24h || 0;
      if (pc24 > 20) { score += 15; reasons.push(`+${pc24.toFixed(0)}% price in 24h`); }
      else if (pc24 > 10) { score += 8; reasons.push(`+${pc24.toFixed(0)}% price in 24h`); }

      const volChange = c.total_volume && c.market_cap
        ? (c.total_volume / (c.market_cap || 1)) * 100
        : 0;
      if (volChange > 50) { score += 10; reasons.push('High volume-to-mcap ratio'); }

      const sym = (c.symbol || '').toUpperCase() + 'USDT';

      // Fetch which exchanges list this coin (only if it passes score threshold)
      const exchanges = score >= MIN_SCORE ? await fetchExchangesWithDelay(c.id) : [];

      const saved = await saveSignal({
        symbol: sym,
        name: c.name,
        score,
        category: 'new_listing',
        reasons,
        price: c.current_price,
        marketCap: c.market_cap,
        volume24h: c.total_volume,
        priceChange: pc24,
        priceChange1h: c.price_change_percentage_1h_in_currency,
        rank: c.market_cap_rank,
        exchanges,
      });
      if (saved) results.push(saved);
    }
  } catch (err) {
    console.warn('[EarlyAlpha] scanNewListings error:', err.message);
  }
  return results;
}

// ─── Scanner 2: CoinGecko trending (most searched in 24h) ────────────────────
async function scanTrending() {
  const results = [];
  try {
    const data = await cgFetch('/search/trending');
    const trendingCoins = data?.coins || [];

    for (const { item: c } of trendingCoins) {
      let score = 60;
      const reasons = ['Currently trending on CoinGecko (top searched 24h)'];

      const pc = c.data?.price_change_percentage_24h?.usd || 0;
      if (pc > 15) { score += 15; reasons.push(`+${pc.toFixed(0)}% price surge`); }
      else if (pc > 5) { score += 8; reasons.push(`+${pc.toFixed(0)}% price movement`); }

      const rank = c.market_cap_rank;
      if (rank > 200) { score += 10; reasons.push('Micro-cap — higher upside potential'); }
      else if (rank < 20) { score -= 10; }

      const sym = (c.symbol || '').toUpperCase() + 'USDT';

      // c.id is the CoinGecko ID (e.g. "bitcoin")
      const exchanges = score >= MIN_SCORE ? await fetchExchangesWithDelay(c.id) : [];

      const saved = await saveSignal({
        symbol: sym,
        name: c.name,
        score,
        category: 'trending',
        reasons,
        price: c.data?.price,
        marketCap: null,
        priceChange: pc,
        rank,
        exchanges,
      });
      if (saved) results.push(saved);
    }
  } catch (err) {
    console.warn('[EarlyAlpha] scanTrending error:', err.message);
  }
  return results;
}

// ─── Scanner 3: Volume spike detector (top-100 by 24h volume) ────────────────
async function scanVolumeSpikes() {
  const results = [];
  try {
    const coins = await cgFetch('/coins/markets', {
      vs_currency: 'usd',
      order: 'volume_desc',
      per_page: 100,
      page: 1,
      price_change_percentage: '1h,24h',
    });

    for (const c of coins) {
      if (!c.total_volume || !c.market_cap || c.market_cap < 1_000_000) continue;
      const volRatio = (c.total_volume / c.market_cap) * 100;
      if (volRatio < 30) continue;

      let score = 45 + Math.min(volRatio / 5, 25);
      const reasons = [`Volume ${volRatio.toFixed(0)}% of market cap in 24h`];

      const pc24 = c.price_change_percentage_24h || 0;
      const pc1h  = c.price_change_percentage_1h_in_currency || 0;

      if (pc24 > 10)  { score += 15; reasons.push(`+${pc24.toFixed(0)}% 24h gain`); }
      if (pc1h > 5)   { score += 10; reasons.push(`+${pc1h.toFixed(0)}% in last 1h`); }
      if (pc24 < -15) { score -= 20; }

      const sym = (c.symbol || '').toUpperCase() + 'USDT';

      const exchanges = score >= MIN_SCORE ? await fetchExchangesWithDelay(c.id) : [];

      const saved = await saveSignal({
        symbol: sym,
        name: c.name,
        score,
        category: 'volume_spike',
        reasons,
        price: c.current_price,
        marketCap: c.market_cap,
        volume24h: c.total_volume,
        volumeChange: volRatio,
        priceChange: pc24,
        priceChange1h: pc1h,
        rank: c.market_cap_rank,
        exchanges,
      });
      if (saved) results.push(saved);
    }
  } catch (err) {
    console.warn('[EarlyAlpha] scanVolumeSpikes error:', err.message);
  }
  return results;
}

// ─── Scanner 4: Whale accumulation (unusual 1h candle on watchlist pairs) ────
// Proxy: 1h candle volume > 3× the 20-bar average AND price up > 1%
// MarketDataService uses Gate.io as primary fallback, so that's our exchange source.
async function scanWhaleAccumulation() {
  const results = [];
  for (const pair of WATCHLIST_PAIRS) {
    try {
      let candles;
      try {
        candles = await marketDataService.fetchCandles(pair, '1h', 'spot', 25);
      } catch {
        continue;
      }
      if (!candles || candles.length < 22) continue;

      const recent   = candles.slice(-21);
      const lastC    = recent[recent.length - 1];
      const avgVol   = recent.slice(0, 20).reduce((s, c) => s + c.volume, 0) / 20;
      const volMulti = avgVol > 0 ? lastC.volume / avgVol : 0;
      const pc1h     = lastC.close > 0 ? ((lastC.close - lastC.open) / lastC.open) * 100 : 0;

      if (volMulti < 3 || pc1h < 1) continue;

      let score = 50 + Math.min((volMulti - 3) * 5, 20) + Math.min(pc1h * 2, 15);
      const reasons = [
        `Volume ${volMulti.toFixed(1)}× above 20-bar avg on 1h candle`,
        `+${pc1h.toFixed(2)}% price in last 1h`,
      ];
      if (volMulti > 6) { score += 10; reasons.push('Extreme volume — possible whale entry'); }

      // Whale scanner uses our own market data feed (Gate.io / Binance)
      // Show the major exchanges known to carry these top-cap pairs
      const knownExchanges = ['Binance', 'Coinbase', 'KuCoin', 'Gate.io', 'OKX'];

      const saved = await saveSignal({
        symbol: pair,
        name: pair.replace('USDT', ''),
        exchange: 'market_feed',
        score,
        category: 'whale_accumulation',
        reasons,
        price: lastC.close,
        volume24h: lastC.volume,
        priceChange1h: pc1h,
        exchanges: knownExchanges.slice(0, 3), // top 3 for display
      });
      if (saved) results.push(saved);
    } catch (err) {
      console.warn(`[EarlyAlpha] whale scan error for ${pair}:`, err.message);
    }
  }
  return results;
}

// ─── Main sweep ───────────────────────────────────────────────────────────────
export async function runAlphaSweep() {
  console.log('[EarlyAlpha] Starting sweep...');

  // Expire signals older than 48 hours
  await AlphaSignal.updateMany(
    { discoveredAt: { $lt: new Date(Date.now() - 48 * 60 * 60 * 1000) }, isActive: true },
    { $set: { isActive: false } }
  );

  // Run scanners (trending + volume in parallel; new listings separately to avoid CG rate limit)
  const [trending, volume, whale] = await Promise.all([
    scanTrending(),
    scanVolumeSpikes(),
    scanWhaleAccumulation(),
  ]);

  // Stagger new listings to avoid CG 429 right after the two above
  await new Promise(r => setTimeout(r, 2000));
  const newListings = await scanNewListings();

  const total = trending.length + volume.length + whale.length + newListings.length;
  console.log(
    `[EarlyAlpha] Sweep complete — ` +
    `trending:${trending.length} volume:${volume.length} ` +
    `whale:${whale.length} new:${newListings.length} (${total} saved)`
  );
  return { trending, volume, whale, newListings, total };
}

export default { runAlphaSweep };
