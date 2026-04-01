/**
 * Arbitrage Service - Main Entry Point
 *
 * This service orchestrates the order book-based arbitrage detection system.
 * It replaces the old ticker-based approach with real, executable opportunities.
 *
 * Features:
 * - Order book-based detection (not ticker/last price)
 * - VWAP-calculated execution prices
 * - Fees and slippage accounted
 * - Liquidity-aware recommendations
 * - Background scanning with caching
 */

import { exchangeManager } from '../../config/Arbitrage/ccxtExchanges.js';
import { discoverArbitragePairs, invalidatePairCache, getPairDiscoveryStats } from './DynamicPairDiscovery.js';
import { scanForArbitrage, createConfig } from './ArbitrageEngine.js';
import { clearOrderBookCache, getOrderBookCacheStats } from './OrderBookService.js';
import ArbitrageOpportunity from '../../models/ArbitrageOpportunity.js';
import Notification from '../../models/Notification.js';
import User from '../../models/User.js';

// ── Transfer status enrichment ─────────────────────────────────────────────
// Cache fetchCurrencies() results per exchange (10-min TTL) to avoid hitting
// rate limits during every scan cycle.
const _currencyCache = new Map(); // exchangeName → { data, ts }
const CURRENCY_CACHE_TTL = 10 * 60 * 1000;

async function getExchangeCurrencies(exchangeName) {
  const cached = _currencyCache.get(exchangeName);
  if (cached && Date.now() - cached.ts < CURRENCY_CACHE_TTL) return cached.data;

  try {
    const exchange = exchangeManager.getExchanges()[exchangeName];
    if (!exchange) return null;

    // Prefer currencies already loaded by loadMarkets()
    if (exchange.currencies && Object.keys(exchange.currencies).length > 0) {
      _currencyCache.set(exchangeName, { data: exchange.currencies, ts: Date.now() });
      return exchange.currencies;
    }
    // Otherwise explicitly fetch — some exchanges require a separate call
    const currencies = await exchange.fetchCurrencies();
    _currencyCache.set(exchangeName, { data: currencies, ts: Date.now() });
    return currencies;
  } catch {
    return null;
  }
}

function extractCoinStatus(currency) {
  if (!currency) return { deposit: null, withdraw: null };
  let deposit = null, withdraw = null;

  if (typeof currency.deposit === 'boolean') deposit = currency.deposit;
  if (typeof currency.withdraw === 'boolean') withdraw = currency.withdraw;
  if (deposit === null && typeof currency.active === 'boolean') deposit = currency.active;
  if (withdraw === null && typeof currency.active === 'boolean') withdraw = currency.active;

  const info = currency.info || {};
  if (deposit === null) {
    const v = info.depositEnable ?? info.isDepositEnabled ?? info.deposit_enabled ??
              info.canDeposit ?? info.enableDeposit ?? info.open_chain_deposit ?? null;
    if (v != null) deposit = v === true || v === 'true' || v === 1 || v === '1';
  }
  if (withdraw === null) {
    const v = info.withdrawEnable ?? info.isWithdrawEnabled ?? info.withdraw_enabled ??
              info.canWithdraw ?? info.enableWithdraw ?? info.open_chain_withdraw ?? null;
    if (v != null) withdraw = v === true || v === 'true' || v === 1 || v === '1';
  }

  if ((deposit === null || withdraw === null) && currency.networks) {
    const nets = Object.values(currency.networks);
    if (nets.length > 0) {
      if (deposit === null)  deposit  = nets.some(n => n.deposit === true  || n.active === true);
      if (withdraw === null) withdraw = nets.some(n => n.withdraw === true || n.active === true);
    }
  }
  return { deposit, withdraw };
}

/**
 * Extract all known contract addresses from a CCXT currency object.
 * Different exchanges expose this under different field names.
 * Returns a Set of lowercase hex addresses (ignoring chain prefixes).
 */
function extractContractAddresses(currency) {
  if (!currency) return new Set();
  const addrs = new Set();

  const normalise = (v) => {
    if (typeof v !== 'string' || v.length < 10) return null;
    // Strip chain prefix like "ETH:" or "BEP20:"
    const raw = v.includes(':') ? v.split(':').pop() : v;
    return raw.toLowerCase();
  };

  const tryAdd = (v) => { const n = normalise(v); if (n) addrs.add(n); };

  // Direct fields
  tryAdd(currency.info?.contractAddress);
  tryAdd(currency.info?.contract_address);
  tryAdd(currency.info?.tokenAddress);
  tryAdd(currency.info?.token_address);
  tryAdd(currency.info?.erc20ContractAddress);
  tryAdd(currency.info?.bep20ContractAddress);
  tryAdd(currency.info?.address);

  // Per-network contract addresses
  if (currency.networks) {
    for (const net of Object.values(currency.networks)) {
      tryAdd(net.id);
      tryAdd(net.info?.contractAddress);
      tryAdd(net.info?.contract_address);
      tryAdd(net.info?.address);
    }
  }

  return addrs;
}

/**
 * Detect ticker collision: same symbol, different underlying coin.
 * Returns true when we can CONFIRM the two exchanges list different coins.
 * Returns false when addresses match OR when we can't determine (unknown).
 *
 * Strategy:
 *  1. Contract address mismatch  → definitive collision
 *  2. Price ratio > 10×          → very likely collision (fallback when no addresses)
 */
function isTickerCollision(buyCurrency, sellCurrency, buyPrice, sellPrice) {
  // ── 1. Contract address comparison ────────────────────────────────────
  const buyAddrs  = extractContractAddresses(buyCurrency);
  const sellAddrs = extractContractAddresses(sellCurrency);

  if (buyAddrs.size > 0 && sellAddrs.size > 0) {
    // Check if ANY address overlaps
    const hasOverlap = [...buyAddrs].some(a => sellAddrs.has(a));
    if (hasOverlap)  return false; // Same contract → definitely same coin
    return true;                   // No overlap    → different coins confirmed
  }

  // ── 2. Price ratio fallback (when contract data unavailable) ──────────
  // Real arbitrage never has a 10× price difference.
  // Native chains (BTC, ETH, SOL) have no contracts — use this as fallback.
  if (buyPrice && sellPrice && buyPrice > 0 && sellPrice > 0) {
    const ratio = Math.max(buyPrice, sellPrice) / Math.min(buyPrice, sellPrice);
    if (ratio > 10) return true;  // 10× price difference → almost certainly different coins
  }

  return false; // Can't confirm collision — allow through
}

/**
 * Enrich opportunities with transfer status + ticker-collision detection.
 * Key for arbitrage: can we WITHDRAW base from the buy exchange and DEPOSIT it to the sell exchange?
 * Quote currency (USDT) stays on each exchange separately — no transfer needed.
 */
async function enrichTransferStatus(opportunities) {
  if (!opportunities.length) return opportunities;

  // Collect unique exchange names
  const exchangeNames = new Set(opportunities.flatMap(o => [o.buyExchange, o.sellExchange]));

  // Fetch currencies for all exchanges in parallel (cached)
  const currencyMap = {};
  await Promise.all([...exchangeNames].map(async name => {
    currencyMap[name] = await getExchangeCurrencies(name);
  }));

  const valid = [];

  for (const opp of opportunities) {
    const baseCoin = opp.symbol.split('/')[0];
    const buyCurs  = currencyMap[opp.buyExchange];
    const sellCurs = currencyMap[opp.sellExchange];

    const buyCurrency  = buyCurs?.[baseCoin]  || null;
    const sellCurrency = sellCurs?.[baseCoin] || null;

    // ── Ticker collision check ─────────────────────────────────────────
    if (isTickerCollision(buyCurrency, sellCurrency, opp.buyPrice, opp.sellPrice)) {
      console.log(`[Arbitrage] Ticker collision detected — ${opp.symbol} on ${opp.buyExchange}/${opp.sellExchange} (different contracts or ${(Math.max(opp.buyPrice, opp.sellPrice)/Math.min(opp.buyPrice, opp.sellPrice)).toFixed(1)}× price ratio). Skipped.`);
      continue; // Drop — not a real arbitrage opportunity
    }

    // ── Transfer status ────────────────────────────────────────────────
    const buyStatus  = extractCoinStatus(buyCurrency);
    const sellStatus = extractCoinStatus(sellCurrency);

    const canWithdraw = buyStatus.withdraw;
    const canDeposit  = sellStatus.deposit;

    if (canWithdraw === true && canDeposit === true) {
      opp.transferStatus = 'Verified';
    } else if (canWithdraw === false || canDeposit === false) {
      opp.transferStatus = 'Blocked';
    } else {
      const notOnBuy  = buyCurs  && !buyCurrency;
      const notOnSell = sellCurs && !sellCurrency;
      opp.transferStatus = (notOnBuy || notOnSell) ? 'Unverified' : 'Unknown';
    }

    opp._transferDetails = {
      buyCanWithdraw:     canWithdraw,
      sellCanDeposit:     canDeposit,
      coinOnBuyExchange:  buyCurs  ? !!buyCurrency  : null,
      coinOnSellExchange: sellCurs ? !!sellCurrency : null,
    };

    valid.push(opp);
  }
  return valid;
}

const ALERT_THRESHOLD_PERCENT = 0.20; // minimum net profit % to store + in-app notification

// Cache for storing opportunities
let cachedOpportunities = [];
let lastUpdateTime = null;
let isCurrentlyFetching = false;
let fetchError = null;
let scanConfig = null;
let _io = null; // Socket.IO instance (set by initializeBackgroundScan)

// Configuration
// Scan every 15 minutes.  Each pair requires one order-book API call per
// exchange (5 exchanges × 50 pairs = 250 calls).  Batched at 5 pairs/batch
// with CCXT rate-limiting; typically completes in 1-2 minutes.
const UPDATE_INTERVAL  = 15 * 60 * 1000; // 15 minutes
const BATCH_SIZE       = 5;              // pairs per batch
const BATCH_DELAY_MS   = 500;            // ms between batches (CCXT handles rate-limits itself)
const MAX_PAIRS_PER_SCAN = 50;           // top pairs — sufficient coverage, lower memory footprint

// Statistics
let serviceStats = {
  totalScans: 0,
  totalOpportunitiesFound: 0,
  lastScanDuration: 0,
  avgOpportunitiesPerScan: 0
};

/**
 * Initialize the arbitrage service with configuration
 *
 * @param {Object} config - Configuration options
 */
export function initializeService(config = {}) {
  scanConfig = createConfig({
    minProfitPercent: config.minProfitPercent ?? 0.01,
    minTradeAmountUSD: config.minTradeAmountUSD ?? 25,       // lowered from 100 — wider net
    maxTradeAmountUSD: config.maxTradeAmountUSD ?? 10000,
    maxSlippagePercent: config.maxSlippagePercent ?? 0.8,    // raised from 0.5 — mid-caps have more slippage
    minLiquidityScore: config.minLiquidityScore ?? 10,       // lowered from 20 — allow thinner books
    orderBookDepth: config.orderBookDepth ?? 10,
    tradeSizesToTest: config.tradeSizesToTest ?? [25, 50, 100, 250, 500, 1000] // start small
  });

  console.log('\n🚀 Arbitrage Service Initialized');
  console.log('   Mode: Order Book Based (VWAP)');
  console.log(`   Min Profit: ${scanConfig.minProfitPercent}%`);
  console.log(`   Max Slippage: ${scanConfig.maxSlippagePercent}%`);
  console.log(`   Trade Sizes: $${scanConfig.tradeSizesToTest.join(', $')}`);
}

/**
 * Get symbols to scan — uses dynamic discovery, falls back to static list.
 * Pairs listed on fewer exchanges are prioritised (wider spreads, less competition).
 */
async function getSymbolsToScan(userPreferences = null) {
  if (userPreferences?.symbols && userPreferences.symbols.length > 0) {
    return userPreferences.symbols;
  }
  const pairs = await discoverArbitragePairs();
  return pairs.slice(0, MAX_PAIRS_PER_SCAN);
}

/**
 * Process symbols in batches to avoid overwhelming exchanges
 */
async function processBatches(symbols, config) {
  const allOpportunities = [];
  const batches = [];

  // Split into batches
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    batches.push(symbols.slice(i, i + BATCH_SIZE));
  }

  console.log(`\n📦 Processing ${batches.length} batches of ${BATCH_SIZE} symbols each...\n`);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    console.log(`\n📊 Batch ${batchIndex + 1}/${batches.length}: ${batch.join(', ')}`);

    // Scan symbols in this batch
    const opportunities = await scanForArbitrage(batch, config);
    allOpportunities.push(...opportunities);

    console.log(`   ✅ Batch complete: ${opportunities.length} opportunities found`);

    // Delay between batches
    if (batchIndex < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return allOpportunities;
}

/**
 * After each scan:
 *  1. Upsert opportunities with net profit ≥ ALERT_THRESHOLD_PERCENT
 *  2. Mark previously-active opportunities as 'cleared' if they disappeared
 *  3. Send one batch email to all users for brand-new opportunities
 */
async function processSignificantOpportunities(opportunities) {
  try {
    const significant = opportunities.filter(
      o => (o.netProfitPercent || 0) >= ALERT_THRESHOLD_PERCENT
    );

    const now = new Date();

    // IDs of significant opportunities found in this scan
    const currentIds = significant.map(
      o => `${o.symbol}-${o.buyExchange}-${o.sellExchange}`
    );

    // ── 1. Upsert each significant opportunity ────────────────────────────
    const newOpportunities = []; // ones that didn't exist before

    for (const opp of significant) {
      const oppId = `${opp.symbol}-${opp.buyExchange}-${opp.sellExchange}`;

      const existing = await ArbitrageOpportunity.findOne({ opportunityId: oppId });

      if (!existing) {
        // Brand new opportunity
        const created = await ArbitrageOpportunity.create({
          opportunityId:       oppId,
          symbol:              opp.symbol,
          buyExchange:         opp.buyExchange,
          sellExchange:        opp.sellExchange,
          netProfitPercent:    opp.netProfitPercent,
          grossSpreadPercent:  opp.grossSpreadPercent,
          expectedProfitUSD:   opp.expectedProfitUSD,
          optimalTradeValueUSD: opp.optimalTradeValueUSD,
          buyPrice:            opp.buyPrice,
          sellPrice:           opp.sellPrice,
          confidenceScore:     opp.confidenceScore,
          riskLevel:           opp.riskLevel,
          transferStatus:      opp.transferStatus || 'Unknown',
          peakProfitPercent:   opp.netProfitPercent,
          status:              'active',
          firstDetectedAt:     now,
          lastSeenAt:          now,
          emailSent:           false,
        });
        newOpportunities.push(created);
      } else if (existing.status === 'cleared') {
        // Opportunity returned after being cleared → treat as new
        // Preserve lastEmailedAt so the 6-hour cooldown still applies
        await ArbitrageOpportunity.findByIdAndUpdate(existing._id, {
          netProfitPercent:    opp.netProfitPercent,
          grossSpreadPercent:  opp.grossSpreadPercent,
          expectedProfitUSD:   opp.expectedProfitUSD,
          optimalTradeValueUSD: opp.optimalTradeValueUSD,
          buyPrice:            opp.buyPrice,
          sellPrice:           opp.sellPrice,
          confidenceScore:     opp.confidenceScore,
          riskLevel:           opp.riskLevel,
          transferStatus:      opp.transferStatus || 'Unknown',
          peakProfitPercent:   Math.max(existing.peakProfitPercent || 0, opp.netProfitPercent),
          status:              'active',
          firstDetectedAt:     now,
          lastSeenAt:          now,
          clearedAt:           undefined,
          // Do NOT reset lastEmailedAt — cooldown check below decides if re-email is needed
        });
        const updated = await ArbitrageOpportunity.findById(existing._id);
        newOpportunities.push(updated);
      } else {
        // Still active — update snapshot and lastSeenAt
        await ArbitrageOpportunity.findByIdAndUpdate(existing._id, {
          netProfitPercent:    opp.netProfitPercent,
          grossSpreadPercent:  opp.grossSpreadPercent,
          expectedProfitUSD:   opp.expectedProfitUSD,
          optimalTradeValueUSD: opp.optimalTradeValueUSD,
          buyPrice:            opp.buyPrice,
          sellPrice:           opp.sellPrice,
          confidenceScore:     opp.confidenceScore,
          riskLevel:           opp.riskLevel,
          transferStatus:      opp.transferStatus || 'Unknown',
          peakProfitPercent:   Math.max(existing.peakProfitPercent || 0, opp.netProfitPercent),
          lastSeenAt:          now,
        });
      }
    }

    // ── 2. Mark active opportunities as cleared if not seen this scan ─────
    await ArbitrageOpportunity.updateMany(
      { status: 'active', opportunityId: { $nin: currentIds } },
      { status: 'cleared', clearedAt: now }
    );

    // ── 3. In-app notifications for brand-new / returned opportunities ──
    if (significant.length > 0 && newOpportunities.length > 0) {
      await emitArbitrageNotifications(newOpportunities);
    }

    if (significant.length > 0) {
      console.log(`[Arbitrage] Stored/updated ${significant.length} significant opportunit${significant.length === 1 ? 'y' : 'ies'} (≥${ALERT_THRESHOLD_PERCENT}%)`);
    }
  } catch (err) {
    // Non-fatal — don't let DB errors break the scan cycle
    console.error('[Arbitrage] processSignificantOpportunities error:', err.message);
  }
}

/**
 * Emit in-app notifications to premium/admin users for new high-profit opportunities.
 * Creates a persisted Notification document + emits notification:new over Socket.IO.
 * Non-fatal — errors are swallowed so they never break the scan cycle.
 */
async function emitArbitrageNotifications(newOpportunities) {
  if (!_io || newOpportunities.length === 0) return;
  try {
    const users = await User.find({
      isActive: true,
      role: { $in: ['premium', 'admin'] },
      walletAddress: { $exists: true, $ne: '' },
    }).select('_id walletAddress').lean();

    if (users.length === 0) return;

    // Notify for at most the top 3 new opportunities to avoid flooding
    const toNotify = newOpportunities.slice(0, 3);

    for (const opp of toNotify) {
      const oppId = opp.opportunityId || `${opp.symbol}-${opp.buyExchange}-${opp.sellExchange}`;
      const profit = (opp.netProfitPercent || 0).toFixed(2);

      for (const user of users) {
        try {
          const notif = await Notification.create({
            userId:      user._id,
            userAddress: user.walletAddress.toLowerCase(),
            type:        'arbitrage_alert',
            title:       `Arbitrage Alert: ${opp.symbol}`,
            message:     `${profit}% net profit — Buy on ${opp.buyExchange}, sell on ${opp.sellExchange}`,
            data: {
              actionUrl:     '/arbitrage',
              opportunityId: oppId,
              symbol:        opp.symbol,
            },
            priority:  opp.netProfitPercent >= 2 ? 'urgent' : 'high',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 h
          });

          _io.to(`user:${user.walletAddress}`).emit('notification:new', notif.toObject());
        } catch (innerErr) {
          console.warn(`[Arbitrage] Notification failed for user ${user.walletAddress}:`, innerErr.message);
        }
      }
    }

    console.log(`[Arbitrage] In-app notifications sent for ${toNotify.length} opportunit${toNotify.length === 1 ? 'y' : 'ies'} to ${users.length} user${users.length === 1 ? '' : 's'}`);
  } catch (err) {
    console.error('[Arbitrage] emitArbitrageNotifications error:', err.message);
  }
}

/**
 * Main scanning function - finds arbitrage opportunities
 */
async function performScan(userPreferences = null) {
  if (isCurrentlyFetching) {
    console.log('⏳ Scan already in progress, skipping...');
    return;
  }

  isCurrentlyFetching = true;
  fetchError = null;
  const startTime = Date.now();

  // Ensure config is initialized
  if (!scanConfig) {
    initializeService();
  }

  // Get active exchanges
  const activeExchanges = Object.keys(exchangeManager.getExchanges());

  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔍 ARBITRAGE SCAN STARTING`);
  console.log(`${'='.repeat(70)}`);
  console.log(`⏰ Time: ${new Date().toLocaleString()}`);
  console.log(`🏦 Active Exchanges (${activeExchanges.length}): ${activeExchanges.join(', ')}`);

  if (activeExchanges.length < 2) {
    console.log(`\n⚠️  ERROR: Need at least 2 exchanges for arbitrage!`);
    console.log(`   Please enable more exchanges in Settings.`);
    isCurrentlyFetching = false;
    fetchError = 'Insufficient exchanges - need at least 2';
    return;
  }

  try {
    // Get symbols to scan (dynamic discovery — pairs on fewer exchanges = wider spreads)
    const symbols = await getSymbolsToScan(userPreferences);
    const discStats = getPairDiscoveryStats();
    console.log(`📋 Symbols to scan: ${symbols.length} (discovery cache age: ${discStats.cacheAge}s)`);

    // Clear order book cache for fresh data
    clearOrderBookCache();

    // Perform the scan in batches
    const rawOpportunities = await processBatches(symbols, scanConfig);

    // Second ticker-collision guard at service level:
    // Drop any opportunity where sell price is > 2× buy price (100% spread).
    // ArbitrageEngine already catches most cases at 25%, but this handles
    // edge cases where VWAP smoothing might mask an extreme collision.
    const sanityFiltered = rawOpportunities.filter(o => {
      if (!o.buyPrice || !o.sellPrice) return true;
      const ratio = o.sellPrice / o.buyPrice;
      return ratio < 2.0; // same coin cannot legitimately be 2× cheaper on one exchange
    });

    // Enrich with transfer status (deposit/withdraw per exchange)
    const opportunities = await enrichTransferStatus(sanityFiltered);

    // Update cache
    cachedOpportunities = opportunities;
    lastUpdateTime = new Date();

    // Push real-time update to all connected clients
    if (_io) {
      _io.emit('arbitrage:update', {
        opportunities,
        count: opportunities.length,
        lastUpdate: lastUpdateTime.toISOString(),
      });
    }

    // Persist significant opportunities and send email alerts
    processSignificantOpportunities(opportunities);

    // Update statistics
    const scanDuration = (Date.now() - startTime) / 1000;
    serviceStats.totalScans++;
    serviceStats.totalOpportunitiesFound += opportunities.length;
    serviceStats.lastScanDuration = scanDuration;
    serviceStats.avgOpportunitiesPerScan =
      serviceStats.totalOpportunitiesFound / serviceStats.totalScans;

    console.log(`\n${'='.repeat(70)}`);
    console.log(`✅ SCAN COMPLETE`);
    console.log(`${'='.repeat(70)}`);
    console.log(`⏱️  Duration: ${scanDuration.toFixed(1)}s`);
    console.log(`📊 Opportunities Found: ${opportunities.length}`);

    if (opportunities.length > 0) {
      const totalPotentialProfit = opportunities.reduce((sum, o) => sum + o.expectedProfitUSD, 0);
      const avgConfidence = opportunities.reduce((sum, o) => sum + o.confidenceScore, 0) / opportunities.length;

      console.log(`💰 Total Potential Profit: $${totalPotentialProfit.toFixed(2)}`);
      console.log(`📈 Avg Confidence: ${avgConfidence.toFixed(1)}%`);

      // Show top 3 opportunities
      console.log(`\n🏆 Top 3 Opportunities:`);
      opportunities.slice(0, 3).forEach((opp, i) => {
        console.log(`   ${i + 1}. ${opp.symbol}: Buy ${opp.buyExchange} → Sell ${opp.sellExchange}`);
        console.log(`      Profit: ${opp.netProfitPercent.toFixed(3)}% ($${opp.expectedProfitUSD.toFixed(2)})`);
        console.log(`      Trade Size: $${opp.optimalTradeValueUSD.toFixed(0)} | Confidence: ${opp.confidenceScore}%`);
      });
    }

    console.log(`\n⏰ Next scan in ${UPDATE_INTERVAL / 1000 / 60} minutes`);
    console.log(`${'='.repeat(70)}\n`);

  } catch (error) {
    console.error('\n❌ Scan failed:', error.message);
    fetchError = error.message;
  } finally {
    isCurrentlyFetching = false;
  }
}

/**
 * Get cached opportunities
 */
export function getCachedOpportunities() {
  return {
    opportunities: cachedOpportunities,
    lastUpdate: lastUpdateTime,
    isLoading: isCurrentlyFetching,
    error: fetchError,
    nextUpdate: lastUpdateTime
      ? new Date(lastUpdateTime.getTime() + UPDATE_INTERVAL)
      : null,
    stats: {
      totalOpportunities: cachedOpportunities.length,
      lastScanDuration: serviceStats.lastScanDuration,
      totalScans: serviceStats.totalScans,
      avgOpportunitiesPerScan: serviceStats.avgOpportunitiesPerScan
    },
    config: scanConfig
  };
}

/**
 * Manual refresh trigger
 */
export async function refreshOpportunities(userPreferences = null) {
  await performScan(userPreferences);
  return getCachedOpportunities();
}

/**
 * Initialize background scanning
 */
const DISCOVERY_REFRESH_INTERVAL = 60 * 60 * 1000; // 1 hour

export function initializeBackgroundScan(config = {}) {
  console.log('\n🚀 Initializing Arbitrage Background Scanner...');

  // Store Socket.IO instance for real-time pushes
  if (config.io) {
    _io = config.io;
    console.log('   🔌 Socket.IO connected — will push arbitrage:update events');
  }

  // Initialize service configuration (exclude io from scan config)
  const { io: _, ...scanOptions } = config;
  initializeService(scanOptions);

  // ── Eager pair discovery at startup (non-blocking) ───────────────────────
  // Runs in background so the first arbitrage scan gets cached pairs instantly
  // instead of blocking on loadMarkets() from all exchanges.
  discoverArbitragePairs()
    .then(pairs => console.log(`   🔍 Pair discovery ready: ${pairs.length} pairs loaded`))
    .catch(err  => console.warn(`   ⚠️  Pair discovery startup failed: ${err.message}`));

  // ── Hourly pair re-discovery (independent of scan cycle) ─────────────────
  // Picks up newly listed coins and re-ranks pairs by arbitrage potential.
  setInterval(() => {
    console.log('\n🔄 [PairDiscovery] Hourly refresh triggered');
    invalidatePairCache();
    discoverArbitragePairs()
      .then(pairs => console.log(`   ✅ Pairs re-discovered: ${pairs.length} pairs`))
      .catch(err  => console.warn(`   ⚠️  Hourly discovery failed: ${err.message}`));
  }, DISCOVERY_REFRESH_INTERVAL);

  // ── Initial arbitrage scan ────────────────────────────────────────────────
  performScan();

  // ── Periodic arbitrage scans (every 5 minutes) ───────────────────────────
  setInterval(() => {
    console.log('\n⏰ Scheduled scan triggered');
    performScan();
  }, UPDATE_INTERVAL);

  console.log(`✅ Background scanner started`);
  console.log(`   Scan interval:      ${UPDATE_INTERVAL / 1000 / 60} minutes`);
  console.log(`   Discovery refresh:  ${DISCOVERY_REFRESH_INTERVAL / 1000 / 60} minutes`);
}

/**
 * Check if service is ready.
 * Returns true once the first scan has completed — even if it found 0 opportunities.
 * The controller handles the empty-cache case by falling back to DB history.
 */
export function isServiceReady() {
  return lastUpdateTime !== null;
}

/**
 * Get service statistics
 */
export function getServiceStats() {
  return {
    ...serviceStats,
    orderBookCache: getOrderBookCacheStats(),
    isLoading: isCurrentlyFetching,
    lastUpdate: lastUpdateTime,
    activeExchanges: Object.keys(exchangeManager.getExchanges()),
    config: scanConfig
  };
}

/**
 * Update service configuration
 */
export function updateConfig(newConfig) {
  scanConfig = createConfig({
    ...scanConfig,
    ...newConfig
  });
  console.log('🔧 Arbitrage service configuration updated');
  return scanConfig;
}

/**
 * Invalidate the dynamic pair discovery cache.
 * Call this when the exchange list changes so new pairs are re-discovered.
 */
export { invalidatePairCache, getPairDiscoveryStats };

// Legacy exports for backward compatibility
export const getCachedOpportunitiesLegacy = getCachedOpportunities;
export const isCacheReady = isServiceReady;

export default {
  initializeService,
  initializeBackgroundScan,
  getCachedOpportunities,
  refreshOpportunities,
  isServiceReady,
  getServiceStats,
  updateConfig,
  invalidatePairCache,
  getPairDiscoveryStats
};
