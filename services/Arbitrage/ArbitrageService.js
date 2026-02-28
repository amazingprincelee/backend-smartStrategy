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
import { TOP_100_PAIRS } from '../../utils/top100Coins.js';
import { scanForArbitrage, createConfig } from './ArbitrageEngine.js';
import { clearOrderBookCache, getOrderBookCacheStats } from './OrderBookService.js';
import ArbitrageOpportunity from '../../models/ArbitrageOpportunity.js';
import User from '../../models/User.js';
import emailService from '../../utils/emailService.js';

const ALERT_THRESHOLD_PERCENT = 2; // minimum net profit % to store + email

// Cache for storing opportunities
let cachedOpportunities = [];
let lastUpdateTime = null;
let isCurrentlyFetching = false;
let fetchError = null;
let scanConfig = null;
let _io = null; // Socket.IO instance (set by initializeBackgroundScan)

// Configuration
const UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes (order books change fast)
const BATCH_SIZE = 5; // Process 5 symbols at a time
const BATCH_DELAY_MS = 1000; // 1 second delay between batches

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
    minProfitPercent: config.minProfitPercent ?? 0.1,
    minTradeAmountUSD: config.minTradeAmountUSD ?? 100,
    maxTradeAmountUSD: config.maxTradeAmountUSD ?? 10000,
    maxSlippagePercent: config.maxSlippagePercent ?? 0.5,
    minLiquidityScore: config.minLiquidityScore ?? 40,
    orderBookDepth: config.orderBookDepth ?? 20,
    tradeSizesToTest: config.tradeSizesToTest ?? [100, 500, 1000, 2500, 5000]
  });

  console.log('\n🚀 Arbitrage Service Initialized');
  console.log('   Mode: Order Book Based (VWAP)');
  console.log(`   Min Profit: ${scanConfig.minProfitPercent}%`);
  console.log(`   Max Slippage: ${scanConfig.maxSlippagePercent}%`);
  console.log(`   Trade Sizes: $${scanConfig.tradeSizesToTest.join(', $')}`);
}

/**
 * Get symbols to scan
 * Can be customized by user preferences
 */
function getSymbolsToScan(userPreferences = null) {
  if (userPreferences?.symbols && userPreferences.symbols.length > 0) {
    return userPreferences.symbols;
  }
  return TOP_100_PAIRS;
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
          emailSent:           false,
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

    // ── 3. Send email for new opportunities ───────────────────────────────
    if (newOpportunities.length > 0) {
      console.log(`[Arbitrage] ${newOpportunities.length} new ≥${ALERT_THRESHOLD_PERCENT}% opportunit${newOpportunities.length === 1 ? 'y' : 'ies'} — emailing users`);

      const users = await User.find({ isActive: true, email: { $exists: true, $ne: '' } })
        .select('email fullName')
        .lean();

      if (users.length > 0) {
        await emailService.sendArbitrageAlert(users, newOpportunities);

        // Mark emailed
        const emailedIds = newOpportunities.map(o => o._id);
        await ArbitrageOpportunity.updateMany({ _id: { $in: emailedIds } }, { emailSent: true });
      }
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
    // Get symbols to scan
    const symbols = getSymbolsToScan(userPreferences);
    console.log(`📋 Symbols to scan: ${symbols.length}`);

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

  // Initial scan
  performScan();

  // Schedule periodic scans
  setInterval(() => {
    console.log('\n⏰ Scheduled scan triggered');
    performScan();
  }, UPDATE_INTERVAL);

  console.log(`✅ Background scanner started (interval: ${UPDATE_INTERVAL / 1000 / 60} minutes)`);
}

/**
 * Check if service is ready
 */
export function isServiceReady() {
  return cachedOpportunities.length > 0 && lastUpdateTime !== null;
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
  updateConfig
};
