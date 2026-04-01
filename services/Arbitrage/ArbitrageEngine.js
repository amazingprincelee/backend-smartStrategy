/**
 * Arbitrage Engine - Core Detection System
 *
 * This is the main engine that detects REAL, executable arbitrage opportunities
 * by combining order book analysis, VWAP calculations, and liquidity metrics.
 *
 * Key Principles:
 * 1. Only use ORDER BOOK data, never ticker/last price
 * 2. Calculate VWAP for realistic execution prices
 * 3. Account for ALL costs: fees, slippage, spread
 * 4. Only report opportunities that can ACTUALLY be executed
 * 5. Provide confidence scores based on liquidity
 */

import { fetchOrderBooksForSymbol } from './OrderBookService.js';
import { calculateArbitrageVWAP, findOptimalArbitrageSize } from './VWAPCalculator.js';
import {
  getExchangeFee,
  calculateLiquidityScore,
  analyzeArbitrageFeasibility
} from './LiquidityAnalyzer.js';

/**
 * Configuration for arbitrage detection
 */
const DEFAULT_CONFIG = {
  minProfitPercent: 0.05,         // Minimum net profit after all costs (5 bps)
  minTradeAmountUSD: 25,          // Minimum trade size (lowered to catch more opportunities)
  maxTradeAmountUSD: 10000,       // Maximum trade size to analyze
  maxSlippagePercent: 0.8,        // Maximum acceptable slippage (raised for mid-cap altcoins)
  minLiquidityScore: 10,          // Minimum liquidity score (lowered to allow thinner order books)
  orderBookDepth: 10,             // Order book depth to fetch
  tradeSizesToTest: [25, 50, 100, 250, 500, 1000] // Start small to find more opportunities
};

/**
 * Arbitrage Opportunity structure
 * @typedef {Object} ArbitrageOpportunity
 * @property {string} id - Unique identifier
 * @property {string} symbol - Trading pair
 * @property {string} buyExchange - Exchange to buy from
 * @property {string} sellExchange - Exchange to sell to
 * @property {number} buyPrice - VWAP buy price
 * @property {number} sellPrice - VWAP sell price
 * @property {number} spreadPercent - Gross spread percentage
 * @property {number} netProfitPercent - Net profit after all costs
 * @property {number} optimalTradeAmount - Best trade size in base currency
 * @property {number} optimalTradeValueUSD - Best trade size in USD
 * @property {number} expectedProfitUSD - Expected profit in USD
 * @property {number} confidenceScore - How reliable this opportunity is (0-100)
 * @property {Object} costs - Breakdown of all costs
 * @property {Object} liquidity - Liquidity metrics
 * @property {number} timestamp - When detected
 */

/**
 * Calculate total costs for an arbitrage trade
 *
 * @param {string} buyExchange - Exchange to buy from
 * @param {string} sellExchange - Exchange to sell to
 * @param {number} buySlippage - Buy side slippage percentage
 * @param {number} sellSlippage - Sell side slippage percentage
 * @returns {Object} Cost breakdown
 */
function calculateTotalCosts(buyExchange, sellExchange, buySlippage = 0, sellSlippage = 0) {
  const buyFee = getExchangeFee(buyExchange) * 100;  // Convert to percentage
  const sellFee = getExchangeFee(sellExchange) * 100;

  return {
    buyFeePercent: buyFee,
    sellFeePercent: sellFee,
    totalFeesPercent: buyFee + sellFee,
    buySlippagePercent: buySlippage,
    sellSlippagePercent: sellSlippage,
    totalSlippagePercent: buySlippage + sellSlippage,
    totalCostPercent: buyFee + sellFee + buySlippage + sellSlippage
  };
}

/**
 * Detect arbitrage opportunity between two order books
 *
 * @param {Object} orderBook1 - First exchange order book
 * @param {Object} orderBook2 - Second exchange order book
 * @param {Object} config - Detection configuration
 * @returns {ArbitrageOpportunity|null} Opportunity if found, null otherwise
 */
function detectArbitragePair(orderBook1, orderBook2, config = DEFAULT_CONFIG) {
  // Try both directions: buy on 1 sell on 2, and buy on 2 sell on 1

  const opportunities = [];

  // Direction 1: Buy on exchange1, sell on exchange2
  const opp1 = analyzeDirection(orderBook1, orderBook2, config);
  if (opp1) opportunities.push(opp1);

  // Direction 2: Buy on exchange2, sell on exchange1
  const opp2 = analyzeDirection(orderBook2, orderBook1, config);
  if (opp2) opportunities.push(opp2);

  // Return the best opportunity (highest profit)
  if (opportunities.length === 0) return null;

  return opportunities.reduce((best, curr) =>
    curr.expectedProfitUSD > best.expectedProfitUSD ? curr : best
  );
}

/**
 * Analyze one direction of arbitrage (buy on A, sell on B)
 *
 * @param {Object} buyOrderBook - Order book to buy from (use asks)
 * @param {Object} sellOrderBook - Order book to sell to (use bids)
 * @param {Object} config - Configuration
 * @returns {ArbitrageOpportunity|null}
 */
// Last-resort spread cap — catches ticker collisions when contract address data
// is unavailable (e.g. native chains, exchanges that don't expose addresses).
// The primary collision check (contract address + 10× price ratio) runs later
// in ArbitrageService.enrichTransferStatus after currencies are fetched.
// 50% gives room for extreme-but-real events while blocking obvious collisions.
const MAX_REALISTIC_SPREAD_PERCENT = 50;

function analyzeDirection(buyOrderBook, sellOrderBook, config) {
  const { bestAsk } = buyOrderBook;
  const { bestBid } = sellOrderBook;

  // Quick check: is there any spread at all?
  if (bestBid <= bestAsk) {
    return null; // No arbitrage possible
  }

  // Calculate gross spread
  const grossSpreadPercent = ((bestBid - bestAsk) / bestAsk) * 100;

  // ── Ticker-collision guard ──────────────────────────────────────────────
  // If the spread is unrealistically large, the two exchanges are almost
  // certainly trading DIFFERENT coins that share the same ticker symbol.
  // Examples: BBT, BIT, ONE, HERO, BIFI etc. are each used by multiple projects.
  // A price ratio > 2× (100% spread) is a near-certain collision.
  if (grossSpreadPercent > MAX_REALISTIC_SPREAD_PERCENT) {
    return null; // Ticker collision — not a real arbitrage opportunity
  }
  // ───────────────────────────────────────────────────────────────────────

  // Get fees
  const costs = calculateTotalCosts(buyOrderBook.exchange, sellOrderBook.exchange);

  // Note: we intentionally do NOT reject here when grossSpread < fees.
  // Near-miss opportunities (spread > 0 but eaten by fees) are still reported
  // so the frontend always shows real market data instead of an empty table.
  // isProfitableAfterFees = false will be set on these rows.

  // Test different trade sizes to find optimal
  let bestOpportunity = null;

  for (const tradeUSD of config.tradeSizesToTest) {
    if (tradeUSD < config.minTradeAmountUSD || tradeUSD > config.maxTradeAmountUSD) {
      continue;
    }

    // Convert USD to base currency amount
    const midPrice = (bestAsk + bestBid) / 2;
    const tradeAmount = tradeUSD / midPrice;

    // Calculate VWAP for this trade size
    const vwapResult = calculateArbitrageVWAP(buyOrderBook, sellOrderBook, tradeAmount);

    if (!vwapResult.canExecute) {
      continue; // Can't fill this size
    }

    // Check slippage constraint
    if (vwapResult.totalSlippage > config.maxSlippagePercent) {
      continue; // Too much slippage
    }

    // Calculate net profit after ALL costs
    const totalCosts = costs.totalFeesPercent + vwapResult.totalSlippage;
    const netProfitPercent = vwapResult.grossProfitPercent - totalCosts;

    // Show near-miss opportunities down to -5% net profit.
    // Truly profitable opportunities (>= config.minProfitPercent) are prioritised;
    // near-miss ones are shown with isProfitableAfterFees = false.
    if (netProfitPercent < -5) {
      continue; // Way too far underwater — skip
    }

    // Calculate liquidity scores
    const buyLiquidity = calculateLiquidityScore(buyOrderBook, tradeUSD);
    const sellLiquidity = calculateLiquidityScore(sellOrderBook, tradeUSD);
    const avgLiquidityScore = (buyLiquidity.score + sellLiquidity.score) / 2;

    if (avgLiquidityScore < config.minLiquidityScore) {
      continue; // Liquidity too low
    }

    // Calculate expected profit in USD
    const expectedProfitUSD = (netProfitPercent / 100) * vwapResult.buyCost;

    // Calculate confidence score
    const confidenceScore = calculateConfidenceScore(
      netProfitPercent,
      avgLiquidityScore,
      vwapResult.totalSlippage,
      vwapResult.buyLevelsUsed,
      vwapResult.sellLevelsUsed
    );

    // Is this better than our current best?
    if (!bestOpportunity || expectedProfitUSD > bestOpportunity.expectedProfitUSD) {
      bestOpportunity = {
        id: `${buyOrderBook.symbol}-${buyOrderBook.exchange}-${sellOrderBook.exchange}-${Date.now()}`,
        symbol: buyOrderBook.symbol,
        buyExchange: buyOrderBook.exchange,
        sellExchange: sellOrderBook.exchange,

        // Prices
        buyPrice: vwapResult.buyVWAP,
        sellPrice: vwapResult.sellVWAP,
        bestBuyPrice: bestAsk,
        bestSellPrice: bestBid,

        // Spread & Profit
        grossSpreadPercent: vwapResult.grossProfitPercent,
        netProfitPercent,
        expectedProfitUSD,

        // Trade size
        optimalTradeAmount: vwapResult.tradeAmount,
        optimalTradeValueUSD: vwapResult.buyCost,

        // Costs breakdown
        costs: {
          ...costs,
          buySlippagePercent: vwapResult.buySlippage,
          sellSlippagePercent: vwapResult.sellSlippage,
          totalSlippagePercent: vwapResult.totalSlippage,
          totalCostPercent: totalCosts
        },

        // Liquidity
        liquidity: {
          buyScore: buyLiquidity.score,
          sellScore: sellLiquidity.score,
          avgScore: avgLiquidityScore,
          buyGrade: buyLiquidity.grade,
          sellGrade: sellLiquidity.grade,
          buyLevelsUsed: vwapResult.buyLevelsUsed,
          sellLevelsUsed: vwapResult.sellLevelsUsed
        },

        // Confidence
        confidenceScore,
        riskLevel: confidenceScore >= 70 ? 'Low' : confidenceScore >= 50 ? 'Medium' : 'High',

        // Profitability flag — false = near-miss (spread exists but eaten by fees)
        isProfitableAfterFees: netProfitPercent >= 0,
        feesPercent: costs.totalFeesPercent,

        // Metadata
        timestamp: Date.now(),
        detectedAt: new Date().toISOString()
      };
    }
  }

  return bestOpportunity;
}

/**
 * Calculate confidence score for an opportunity
 * Higher score = more confident the trade will succeed
 *
 * @param {number} profitPercent - Net profit percentage
 * @param {number} liquidityScore - Average liquidity score
 * @param {number} slippage - Total slippage percentage
 * @param {number} buyLevels - Number of buy order book levels used
 * @param {number} sellLevels - Number of sell order book levels used
 * @returns {number} Confidence score 0-100
 */
function calculateConfidenceScore(profitPercent, liquidityScore, slippage, buyLevels, sellLevels) {
  let score = 50; // Base score

  // Profit factor (max +25)
  // Higher profit = more buffer for errors
  score += Math.min(25, profitPercent * 10);

  // Liquidity factor (max +25)
  score += liquidityScore * 0.25;

  // Slippage penalty (max -20)
  score -= slippage * 10;

  // Order book depth factor
  // Using fewer levels = more confident in price
  const avgLevels = (buyLevels + sellLevels) / 2;
  if (avgLevels <= 2) score += 10;
  else if (avgLevels <= 5) score += 5;
  else score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Scan for arbitrage opportunities across all exchanges for a symbol
 *
 * @param {string} symbol - Trading pair to scan
 * @param {Object} config - Detection configuration
 * @returns {Promise<ArbitrageOpportunity[]>} List of opportunities found
 */
export async function scanSymbolForArbitrage(symbol, config = DEFAULT_CONFIG) {
  // Fetch order books from all active exchanges
  const orderBooks = await fetchOrderBooksForSymbol(symbol, null, config.orderBookDepth);

  if (orderBooks.size < 2) {
    return []; // Need at least 2 exchanges
  }

  const opportunities = [];
  const exchangeList = Array.from(orderBooks.keys());

  // Track best near-miss for diagnostics
  let bestRawSpread = { spread: 0, pair: '', fees: 0 };

  // Compare all pairs of exchanges
  for (let i = 0; i < exchangeList.length; i++) {
    for (let j = i + 1; j < exchangeList.length; j++) {
      const exchange1 = exchangeList[i];
      const exchange2 = exchangeList[j];

      const orderBook1 = orderBooks.get(exchange1);
      const orderBook2 = orderBooks.get(exchange2);

      // Track raw spread diagnostic (best bid on either side vs best ask on the other)
      const rawSpread1 = orderBook2.bestBid > orderBook1.bestAsk
        ? ((orderBook2.bestBid - orderBook1.bestAsk) / orderBook1.bestAsk) * 100 : 0;
      const rawSpread2 = orderBook1.bestBid > orderBook2.bestAsk
        ? ((orderBook1.bestBid - orderBook2.bestAsk) / orderBook2.bestAsk) * 100 : 0;
      const rawSpread = Math.max(rawSpread1, rawSpread2);
      const fees = (getExchangeFee(exchange1) + getExchangeFee(exchange2)) * 100;
      if (rawSpread > bestRawSpread.spread) {
        bestRawSpread = {
          spread: rawSpread,
          fees,
          gap: rawSpread - fees,
          pair: rawSpread1 > rawSpread2
            ? `buy ${exchange1} → sell ${exchange2}`
            : `buy ${exchange2} → sell ${exchange1}`
        };
      }

      const opportunity = detectArbitragePair(orderBook1, orderBook2, config);

      if (opportunity) {
        opportunities.push(opportunity);
      }
    }
  }

  // Log near-miss for symbols that had any positive cross-exchange spread
  if (opportunities.length === 0 && bestRawSpread.spread > 0) {
    console.log(`   📊 ${symbol}: best raw spread ${bestRawSpread.spread.toFixed(4)}% (fees ${bestRawSpread.fees.toFixed(2)}%, gap ${bestRawSpread.gap.toFixed(4)}%) — ${bestRawSpread.pair}`);
  }

  // Sort by expected profit descending
  return opportunities.sort((a, b) => b.expectedProfitUSD - a.expectedProfitUSD);
}

/**
 * Scan multiple symbols for arbitrage opportunities
 *
 * @param {string[]} symbols - List of trading pairs
 * @param {Object} config - Detection configuration
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<ArbitrageOpportunity[]>} All opportunities found
 */
export async function scanForArbitrage(symbols, config = DEFAULT_CONFIG, onProgress = null) {
  const allOpportunities = [];
  let processed = 0;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔍 ARBITRAGE ENGINE - Order Book Based Detection`);
  console.log(`📊 Scanning ${symbols.length} symbols`);
  console.log(`⚙️  Config: minProfit=${config.minProfitPercent}%, maxSlippage=${config.maxSlippagePercent}%`);
  console.log(`${'='.repeat(60)}\n`);

  for (const symbol of symbols) {
    try {
      const opportunities = await scanSymbolForArbitrage(symbol, config);

      if (opportunities.length > 0) {
        allOpportunities.push(...opportunities);
        console.log(`✅ ${symbol}: Found ${opportunities.length} opportunity(ies)`);

        // Log the best one
        const best = opportunities[0];
        console.log(`   Best: Buy ${best.buyExchange} → Sell ${best.sellExchange}`);
        console.log(`   Profit: ${best.netProfitPercent.toFixed(3)}% ($${best.expectedProfitUSD.toFixed(2)})`);
        console.log(`   Confidence: ${best.confidenceScore}% (${best.riskLevel} risk)`);
      }

      processed++;
      if (onProgress) {
        onProgress({
          processed,
          total: symbols.length,
          symbol,
          opportunitiesFound: allOpportunities.length
        });
      }

      // Small delay to be nice to exchanges
      await new Promise(resolve => setTimeout(resolve, 100));

    } catch (error) {
      console.warn(`⚠️  ${symbol}: Scan failed - ${error.message}`);
      processed++;
    }
  }

  // Sort all opportunities by profit
  const sortedOpportunities = allOpportunities.sort((a, b) =>
    b.expectedProfitUSD - a.expectedProfitUSD
  );

  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ SCAN COMPLETE`);
  console.log(`📊 Total Opportunities: ${sortedOpportunities.length}`);
  if (sortedOpportunities.length > 0) {
    const totalPotentialProfit = sortedOpportunities.reduce((sum, o) => sum + o.expectedProfitUSD, 0);
    console.log(`💰 Total Potential Profit: $${totalPotentialProfit.toFixed(2)}`);
  }
  console.log(`${'='.repeat(60)}\n`);

  return sortedOpportunities;
}

/**
 * Get default configuration
 */
export function getDefaultConfig() {
  return { ...DEFAULT_CONFIG };
}

/**
 * Create custom configuration
 */
export function createConfig(overrides = {}) {
  return { ...DEFAULT_CONFIG, ...overrides };
}

export default {
  scanSymbolForArbitrage,
  scanForArbitrage,
  getDefaultConfig,
  createConfig,
  calculateTotalCosts
};
