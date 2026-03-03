import ccxt from "ccxt";
// Use new Order Book-based Arbitrage Service
import {
  getCachedOpportunities,
  refreshOpportunities,
  isServiceReady,
  getServiceStats
} from "../services/Arbitrage/ArbitrageService.js";
import { exchangeManager } from "../config/Arbitrage/ccxtExchanges.js";
import ArbitrageOpportunity from "../models/ArbitrageOpportunity.js";

// Get all exchanges that is listed on ccxt
export const fetchExchanges = async (req, res) => {
  try {
    const exchanges = await ccxt.exchanges;
    
    return res.status(200).json({ exchanges: exchanges });
    
  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
}

// Get arbitrage opportunities from cache
export const getArbitrageOpportunities = async (req, res) => {
  try {
    console.log('📡 API request received for arbitrage opportunities');

    const cacheData = getCachedOpportunities();

    // Service truly not yet started (no scan has run at all)
    if (!cacheData.lastUpdate && !cacheData.isLoading) {
      return res.status(503).json({
        success: false,
        message: 'Arbitrage service is initializing. Please try again in a few moments.',
        isLoading: false,
        error: cacheData.error || 'Service not initialized'
      });
    }

    // Currently loading and no scan has completed yet
    if (cacheData.isLoading && !cacheData.lastUpdate) {
      return res.status(202).json({
        success: false,
        message: 'Arbitrage opportunities are currently being loaded. Please try again later.',
        isLoading: true,
        estimatedWaitTime: '2-5 minutes',
        retryAfter: 60 // seconds
      });
    }

    // Determine what opportunities to return
    let opportunities = [...(cacheData.opportunities || [])];
    let isStale = false;

    // Live cache is empty — fall back to most recent DB history so the page is never blank
    if (opportunities.length === 0) {
      const recent = await ArbitrageOpportunity
        .find({})
        .sort({ lastSeenAt: -1 })
        .limit(10)
        .lean();

      if (recent.length > 0) {
        opportunities = recent.map(r => ({ ...r, isStale: true, staleSince: r.lastSeenAt }));
        isStale = true;
        console.log(`[Arbitrage] No live cache — returning ${recent.length} historical record(s) as stale fallback`);
      }
    }

    // Return data (live or stale)
    res.json({
      success: true,
      count: opportunities.length,
      data: opportunities,
      isStale,
      metadata: {
        lastUpdate: cacheData.lastUpdate,
        nextUpdate: cacheData.nextUpdate,
        isRefreshing: cacheData.isLoading,
        dataAge: cacheData.lastUpdate
          ? Math.floor((Date.now() - cacheData.lastUpdate.getTime()) / 1000)
          : null,
        dataAgeFormatted: cacheData.lastUpdate
          ? formatTimeSince(cacheData.lastUpdate)
          : 'N/A'
      }
    });

  } catch (error) {
    console.error('❌ Error fetching opportunities:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Manual refresh endpoint (optional - use with caution)
export const refreshArbitrageOpportunities = async (req, res) => {
  try {
    console.log('🔄 Manual refresh requested');
    
    const cacheData = getCachedOpportunities();
    
    // Prevent multiple simultaneous refreshes
    if (cacheData.isLoading) {
      return res.status(429).json({
        success: false,
        message: 'A refresh is already in progress. Please wait.',
        isLoading: true
      });
    }
    
    // Trigger refresh in background
    refreshOpportunities().catch(err => {
      console.error('Error during manual refresh:', err);
    });
    
    res.json({
      success: true,
      message: 'Refresh started. Data will be updated in a few minutes.',
      isLoading: true,
      estimatedTime: '2-5 minutes'
    });
    
  } catch (error) {
    console.error('❌ Error triggering refresh:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get service status
export const getArbitrageStatus = async (req, res) => {
  try {
    const cacheData = getCachedOpportunities();
    const serviceStats = getServiceStats();

    res.json({
      success: true,
      status: {
        isReady: isServiceReady(),
        isLoading: cacheData.isLoading,
        opportunitiesCount: cacheData.opportunities.length,
        lastUpdate: cacheData.lastUpdate,
        nextUpdate: cacheData.nextUpdate,
        dataAge: cacheData.lastUpdate
          ? Math.floor((Date.now() - cacheData.lastUpdate.getTime()) / 1000)
          : null,
        error: cacheData.error
      },
      performance: cacheData.stats,
      rateLimiting: serviceStats.rateLimitStatus,
      fetchStats: serviceStats.fetchStats
    });

  } catch (error) {
    console.error('❌ Error fetching status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Update enabled exchanges for scanning
export const updateEnabledExchanges = async (req, res) => {
  try {
    const { exchanges } = req.body;

    if (!Array.isArray(exchanges) || exchanges.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'exchanges must be a non-empty array'
      });
    }

    // Validate all exchange IDs
    const invalidExchanges = exchanges.filter(id => !ccxt.exchanges.includes(id.toLowerCase()));
    if (invalidExchanges.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Invalid exchange IDs: ${invalidExchanges.join(', ')}`
      });
    }

    console.log(`🔄 Updating enabled exchanges to: ${exchanges.join(', ')}`);

    // Update the exchange manager
    exchangeManager.setEnabledExchanges(exchanges);

    // Trigger a refresh to use new exchanges
    refreshOpportunities().catch(err => {
      console.error('Error refreshing after exchange update:', err);
    });

    res.json({
      success: true,
      message: 'Exchanges updated successfully. Refresh started.',
      enabledExchanges: exchangeManager.getEnabledIds()
    });

  } catch (error) {
    console.error('❌ Error updating exchanges:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get currently enabled exchanges
export const getEnabledExchanges = async (req, res) => {
  try {
    res.json({
      success: true,
      enabledExchanges: exchangeManager.getEnabledIds(),
      availableExchanges: ccxt.exchanges.length,
      note: 'Use PUT /api/arbitrage/exchanges to update the list'
    });
  } catch (error) {
    console.error('❌ Error getting enabled exchanges:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get past/stored significant opportunities (≥0.20% net profit)
export const getPastOpportunities = async (req, res) => {
  try {
    const { status = 'all', limit = 10, page = 1 } = req.query;
    const pageNum  = Math.max(1, parseInt(page)  || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit) || 10), 100);
    const skip     = (pageNum - 1) * limitNum;

    const query = status !== 'all' ? { status } : {};

    const [opportunities, filteredTotal, activeCount, clearedCount] = await Promise.all([
      ArbitrageOpportunity.find(query)
        .sort({ firstDetectedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      ArbitrageOpportunity.countDocuments(query),
      ArbitrageOpportunity.countDocuments({ status: 'active' }),
      ArbitrageOpportunity.countDocuments({ status: 'cleared' }),
    ]);

    const pages = Math.ceil(filteredTotal / limitNum) || 1;

    res.json({
      success: true,
      count: opportunities.length,
      data: opportunities,
      meta: {
        activeCount,
        clearedCount,
        total: activeCount + clearedCount,
      },
      pagination: {
        page:     pageNum,
        limit:    limitNum,
        total:    filteredTotal,
        pages,
        hasNext:  pageNum < pages,
        hasPrev:  pageNum > 1,
      },
    });
  } catch (err) {
    console.error('❌ Error fetching past opportunities:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// Summary stats for stat cards (aggregated from DB history)
export const getPastOpportunitiesSummary = async (req, res) => {
  try {
    const [counts, agg] = await Promise.all([
      // active / cleared counts
      ArbitrageOpportunity.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      // best + avg net profit
      ArbitrageOpportunity.aggregate([
        {
          $group: {
            _id: null,
            total:         { $sum: 1 },
            bestProfit:    { $max: '$netProfitPercent' },
            avgProfit:     { $avg: '$netProfitPercent' },
          }
        }
      ])
    ]);

    const activeCount   = counts.find(c => c._id === 'active')?.count  || 0;
    const clearedCount  = counts.find(c => c._id === 'cleared')?.count || 0;
    const total         = agg[0]?.total        ?? 0;
    const bestProfit    = agg[0]?.bestProfit   ?? null;
    const avgProfit     = agg[0]?.avgProfit    ?? null;

    res.json({
      success: true,
      summary: {
        total,
        activeCount,
        clearedCount,
        bestNetProfit: bestProfit !== null ? parseFloat(bestProfit.toFixed(4)) : null,
        avgNetProfit:  avgProfit  !== null ? parseFloat(avgProfit.toFixed(4))  : null,
      }
    });
  } catch (err) {
    console.error('❌ Error fetching summary:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// Helper function to format time
function formatTimeSince(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}