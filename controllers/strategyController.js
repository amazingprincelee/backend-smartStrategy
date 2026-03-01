/**
 * Strategy catalog - static metadata about all available strategies.
 * No database required.
 */

const STRATEGY_CATALOG = [
  {
    id: 'adaptive_grid',
    name: 'Adaptive Grid Averager',
    description: 'Splits capital into portions and buys dips using ATR-based grid spacing with multi-confirmation trend filters (EMA50/200 + market structure). Structure-based take-profit targets actual resistance levels. Best for ranging or downtrending markets.',
    riskLevel: 'medium',
    timeframe: '1h',
    supportedMarkets: ['spot', 'futures'],
    isDefault: true,
    bestFor: ['Ranging markets', 'Downtrends', 'Risk-managed accumulation'],
    defaultParams: {
      portions: 5,
      rsiOversold: 30,
      rsiOverbought: 70,
      atrPeriod: 14,
      emaPeriod1: 50,
      emaPeriod2: 200,
      takeProfitMode: 'structure',
      fixedTakeProfitPercent: 1.5,
      trailingStopActivationPercent: 2.0,
      trailingStopDistancePercent: 0.5,
      stopLossAtrMultiplier: 2.0
    }
  },
  {
    id: 'dca',
    name: 'Simple DCA',
    description: 'Buys a fixed dollar amount at regular time intervals regardless of price. Simple, proven, and effective for long-term accumulation. Supports futures with configurable leverage.',
    riskLevel: 'low',
    timeframe: '4h',
    supportedMarkets: ['spot', 'futures'],
    isDefault: false,
    bestFor: ['Long-term accumulation', 'Beginners', 'Passive investing'],
    defaultParams: {
      dcaIntervalHours: 24,
      dcaAmountPerOrder: 100,
      fixedTakeProfitPercent: 2.0,
      stopLossAtrMultiplier: 3.0,
      leverage: 1
    }
  },
  {
    id: 'rsi_reversal',
    name: 'RSI Reversal',
    description: 'Buys when RSI drops below the oversold threshold (default 30) and sells when RSI rises above overbought (default 70). Classic mean-reversion strategy that works well in sideways markets.',
    riskLevel: 'medium',
    timeframe: '1h',
    supportedMarkets: ['spot', 'futures'],
    isDefault: false,
    bestFor: ['Sideways markets', 'Mean reversion', 'Intermediate traders'],
    defaultParams: {
      rsiOversold: 30,
      rsiOverbought: 70,
      atrPeriod: 14,
      stopLossAtrMultiplier: 2.0
    }
  },
  {
    id: 'ema_crossover',
    name: 'EMA Crossover',
    description: 'Buys on a golden cross (EMA50 crosses above EMA200) and closes all positions on a death cross. Classic trend-following strategy that captures medium to long-term trends.',
    riskLevel: 'low',
    timeframe: '4h',
    supportedMarkets: ['spot', 'futures'],
    isDefault: false,
    bestFor: ['Trending markets', 'Long-term trends', 'Set-and-forget'],
    defaultParams: {
      emaPeriod1: 50,
      emaPeriod2: 200,
      atrPeriod: 14,
      stopLossAtrMultiplier: 2.0
    }
  },
  {
    id: 'scalper',
    name: 'ATR Scalper',
    description: 'High-frequency grid with very tight 0.3-0.5% targets. Uses EMA9/21 for direction. Best for highly liquid pairs with low spreads. Generates many small profits quickly.',
    riskLevel: 'high',
    timeframe: '5m',
    supportedMarkets: ['spot', 'futures'],
    isDefault: false,
    bestFor: ['High-liquidity pairs', 'Short-term gains', 'Active management'],
    defaultParams: {
      scalperGridSpacing: 0.004,
      atrPeriod: 14
    }
  },
  {
    id: 'breakout',
    name: 'N-Day Breakout',
    description: 'Buys when price breaks above the N-day high with volume confirmation (1.5x average). Uses a measured-move projection for take profit. Momentum-based strategy.',
    riskLevel: 'medium',
    timeframe: '1d',
    supportedMarkets: ['spot', 'futures'],
    isDefault: false,
    bestFor: ['Momentum markets', 'Strong uptrends', 'Breakout trading'],
    defaultParams: {
      breakoutLookbackDays: 20,
      atrPeriod: 14,
      stopLossAtrMultiplier: 2.0
    }
  },
  {
    id: 'ai_signal',
    name: 'AI Signal Bot',
    description: 'Uses a multi-indicator technical analysis engine (RSI, EMA20/50/200, MACD, Bollinger Bands, momentum) to detect high-confidence LONG opportunities. Fires when ≥3 of 6 indicators agree. ATR-based SL/TP guarantees a 2:1 R:R on every trade.',
    riskLevel: 'low',
    timeframe: '1h',
    supportedMarkets: ['spot', 'futures'],
    isDefault: false,
    bestFor: ['Trending markets', 'AI-driven trading', 'Consistent R:R management'],
    defaultParams: {
      leverage: 1
    }
  }
];

export const getStrategyCatalog = (req, res) => {
  res.json({
    success: true,
    data: {
      strategies: STRATEGY_CATALOG,
      count: STRATEGY_CATALOG.length
    }
  });
};

export const getStrategyById = (req, res) => {
  const strategy = STRATEGY_CATALOG.find(s => s.id === req.params.id);
  if (!strategy) {
    return res.status(404).json({ success: false, message: 'Strategy not found' });
  }
  res.json({ success: true, data: { strategy } });
};
