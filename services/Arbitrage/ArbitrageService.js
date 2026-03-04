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
import emailService from '../../utils/emailService.js';

const ALERT_THRESHOLD_PERCENT = 0.20; // minimum net profit % to store + email + in-app notification
const EMAIL_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours between emails for the same opportunity

// Cache for storing opportunities
let cachedOpportunities = [];
let lastUpdateTime = null;
let isCurrentlyFetching = false;
let fetchError = null;
let scanConfig = null;
let _io = null; // Socket.IO instance (set by initializeBackgroundScan)

// Configuration
// Scan every 5 minutes.  Each pair requires one order-book API call per
// exchange (5 exchanges × 80 pairs = 400 calls).  Batched at 5 pairs/batch
// with CCXT rate-limiting; typically completes in 2-4 minutes.
const UPDATE_INTERVAL  = 5 * 60 * 1000; // 5 minutes
const BATCH_SIZE       = 5;             // pairs per batch
const BATCH_DELAY_MS   = 500;           // ms between batches (CCXT handles rate-limits itself)
const MAX_PAIRS_PER_SCAN = 110;         // scan full list — small-caps have the widest spreads

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
    orderBookDepth: config.orderBookDepth ?? 20,
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

    // ── 3. Send email for new/returned opportunities (6-hour cooldown per pair) ──
    if (newOpportunities.length > 0) {
      // Only email opportunities that haven't been emailed in the last 6 hours
      const cooldownEligible = newOpportunities.filter(opp => {
        if (!opp.lastEmailedAt) return true;
        return (Date.now() - new Date(opp.lastEmailedAt).getTime()) >= EMAIL_COOLDOWN_MS;
      });

      if (cooldownEligible.length > 0) {
        console.log(`[Arbitrage] ${cooldownEligible.length} opportunit${cooldownEligible.length === 1 ? 'y' : 'ies'} passed 6-hour cooldown — emailing opted-in users`);

        // Only email users who have arbitrageAlert enabled (default: true)
        const users = await User.find({
          isActive: true,
          email: { $exists: true, $ne: '' },
          role: { $in: ['premium', 'admin'] },
          'preferences.emailNotifications.arbitrageAlert': { $ne: false },
        })
        .select('email fullName')
        .lean();

        if (users.length > 0) {
          await emailService.sendArbitrageAlert(users, cooldownEligible);

          // Stamp lastEmailedAt so cooldown starts now
          const emailedIds = cooldownEligible.map(o => o._id);
          await ArbitrageOpportunity.updateMany(
            { _id: { $in: emailedIds } },
            { emailSent: true, lastEmailedAt: new Date() }
          );
        } else {
          console.log('[Arbitrage] No opted-in users to email');
        }
      } else {
        console.log(`[Arbitrage] ${newOpportunities.length} new opportunit${newOpportunities.length === 1 ? 'y' : 'ies'} — all within 6-hour cooldown, skipping email`);
      }

      // In-app notifications are not subject to the email cooldown
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
    const opportunities = await processBatches(symbols, scanConfig);

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
