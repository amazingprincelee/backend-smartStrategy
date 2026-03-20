/**
 * SmartSignalStrategy
 *
 * Reads from the Signal collection (populated by the 30-min sweep cron) and
 * automatically enters trades on the highest-scored opportunities.
 * Supports two execution modes:
 *   auto   — selects and executes the best single signal automatically
 *   manual — scores top 3 signals, stores in bot.pendingSignals for user to pick
 *
 * Configuration (bot.strategyParams):
 *   minConfidencePercent  (number, 60)  — pre-filter before scoring
 *   maxConcurrentTrades   (number, 1)   — max open positions (default 1)
 *   riskPerTrade          (number, 2)   — % of totalCapital per trade
 *   leverage              (number, 3)   — futures leverage (ignored for spot)
 *   signalMaxAgeMinutes   (number, 120) — reject signals older than this
 *
 * Safety features:
 *   - Uses LIVE market price for position sizing
 *   - Skips signals where current price drifted >2% from signal entry
 *   - Caps effectiveRisk = riskPerTrade * leverage at maxLeverageRiskPct
 *   - Cooldown enforcement between trades
 *   - Consecutive loss pause (2 losses → 1h pause)
 *   - Daily loss limit check before entry
 */

import Signal from '../../models/Signal.js';
import BotConfig from '../../models/bot/BotConfig.js';
import marketDataService from '../MarketDataService.js';
import scoringEngine from '../SignalScoringEngine.js';

// Generous window — sweep runs every 30 min, so 6 h covers restarts.
const DEFAULT_MAX_AGE_MIN = 360;

// If current market price has drifted more than this % from the signal's entry,
// the signal is too stale to enter safely.
const MAX_PRICE_DRIFT_PCT = 2.0;

class SmartSignalStrategy {
  async analyze(bot, _candles, openPositions) {
    const params        = bot.strategyParams || {};
    const minConfidence = (params.minConfidencePercent || 50) / 100;
    const maxConcurrent = params.maxConcurrentTrades   || 3;
    const riskPct       = params.riskPerTrade          || 2;
    const leverage      = bot.marketType === 'futures' ? (params.leverage || 3) : 1;
    const ageMin        = Math.max(60, params.signalMaxAgeMinutes || DEFAULT_MAX_AGE_MIN);
    const maxAgeMs      = ageMin * 60 * 1000;
    const capital       = bot.capitalAllocation?.totalCapital || 100;
    const marketType    = bot.marketType || 'spot';

    // Leverage safety cap: riskPerTrade × leverage cannot exceed maxLeverageRiskPct.
    // e.g. riskPerTrade=5%, leverage=10× → effectiveRisk=50% — too dangerous.
    // We cap riskPct down so effectiveRisk stays ≤ maxLeverageRiskPct.
    const maxEffectiveRisk = bot.riskParams?.maxLeverageRiskPct || 20;
    const cappedRiskPct    = Math.min(riskPct, maxEffectiveRisk / leverage);
    if (cappedRiskPct < riskPct) {
      console.warn(
        `[SmartSignal] bot=${bot.name} risk capped: ${riskPct}%×${leverage}lev ` +
        `would exceed ${maxEffectiveRisk}% → using ${cappedRiskPct.toFixed(2)}% risk instead`
      );
    }

    // ── Kelly Criterion position sizing (optional) ───────────────────────────
    // When the bot has ≥20 closed trades and useKellysizing is enabled, replace
    // the fixed riskPerTrade% with the Kelly formula:
    //   f* = W/A - (1-W)/B
    //   where W = win rate, A = avg loss (as fraction), B = avg win (as fraction)
    // Half-Kelly (f*/2) is used for safety — full Kelly is too aggressive.
    // Falls back to cappedRiskPct if Kelly < 0.5% or < 10 trades yet.
    const useKelly   = params.useKellySizing === true;
    const closedTrades = (bot.stats?.winningTrades || 0) + (bot.stats?.losingTrades || 0);
    let finalRiskPct = cappedRiskPct;

    if (useKelly && closedTrades >= 20) {
      const W    = (bot.stats.winRate || 0) / 100;                      // win rate 0–1
      const grossP = bot.stats.grossProfit || 0;
      const grossL = bot.stats.grossLoss   || 0;
      const wins   = bot.stats.winningTrades || 1;
      const losses = bot.stats.losingTrades  || 1;
      const avgWin  = wins   > 0 ? (grossP / wins)   / capital : 0.01; // avg win as fraction
      const avgLoss = losses > 0 ? (grossL / losses)  / capital : 0.01; // avg loss as fraction
      if (avgWin > 0 && avgLoss > 0) {
        const kellyFull = W / avgLoss - (1 - W) / avgWin;
        const halfKelly = kellyFull / 2;
        const kellyCapped = Math.min(Math.max(halfKelly * 100, 0.5), maxEffectiveRisk / leverage);
        if (kellyCapped > 0) {
          finalRiskPct = kellyCapped;
          console.log(
            `[SmartSignal] Kelly sizing: W=${(W*100).toFixed(0)}% avgWin=${(avgWin*100).toFixed(2)}% ` +
            `avgLoss=${(avgLoss*100).toFixed(2)}% → halfKelly=${(halfKelly*100).toFixed(2)}% ` +
            `(capped at ${finalRiskPct.toFixed(2)}%)`
          );
        }
      }
    }

    const signals = [];

    // ── 1. Exit checks for all open positions ────────────────────────────────
    // currentPrice on each position is updated by BotEngine before analyze() runs.
    for (const pos of openPositions) {
      const price = pos.currentPrice;
      if (!price) continue;

      const isShort = pos.side === 'short';

      // ── Ladder exit: TP1 (50% at 1:1 R:R) ──────────────────────────────
      // TP1 fires once. After TP1 hit, SL moves to breakeven and trailing
      // stop activates on the remaining 50%.
      if (pos.tp1Price && !pos.tp1Hit) {
        const hitTP1 = isShort ? price <= pos.tp1Price : price >= pos.tp1Price;
        if (hitTP1) {
          signals.push({
            action:            'partial_sell',
            positionId:        pos._id,
            portionIndex:      pos.portionIndex,
            portion:           0.5,
            reason:            'take_profit_1',
            moveSlToBreakeven: true,
          });
          continue; // don't also check TP2 this same tick
        }
      }

      // ── Full exit: TP2 / SL / Trailing stop ─────────────────────────────
      const hitTP = pos.takeProfitPrice && (
        isShort ? price <= pos.takeProfitPrice : price >= pos.takeProfitPrice
      );
      const hitSL = pos.stopLossPrice && (
        isShort ? price >= pos.stopLossPrice : price <= pos.stopLossPrice
      );
      // Trailing stop (activated after TP1 hits in ladder mode, or configured threshold)
      const hitTrail = pos.trailingStopActive && pos.trailingStopPrice && (
        isShort ? price >= pos.trailingStopPrice : price <= pos.trailingStopPrice
      );

      if (hitTP) {
        signals.push({ action: 'sell', positionId: pos._id, portionIndex: pos.portionIndex, reason: 'take_profit' });
      } else if (hitTrail) {
        signals.push({ action: 'sell', positionId: pos._id, portionIndex: pos.portionIndex, reason: 'trailing_stop' });
      } else if (hitSL) {
        signals.push({ action: 'sell', positionId: pos._id, portionIndex: pos.portionIndex, reason: 'stop_loss' });
      }
    }

    // Process exits first — don't open new positions in the same tick as a close
    if (signals.length > 0) return signals;

    // ── 2. Check capacity ────────────────────────────────────────────────────
    if (openPositions.length >= maxConcurrent) return signals;

    // ── 3. Cooldown check ────────────────────────────────────────────────────
    if (bot.cooldownUntil && new Date() < new Date(bot.cooldownUntil)) {
      const remaining = Math.ceil((new Date(bot.cooldownUntil) - Date.now()) / 60000);
      console.log(`[SmartSignal] bot=${bot.name} — cooldown active, ${remaining}min remaining`);
      return signals;
    }

    // ── 4. Consecutive loss pause (2 losses → 1h pause) ─────────────────────
    const consecutiveLosses = bot.stats?.consecutiveLosses || 0;
    if (consecutiveLosses >= 2) {
      const pauseUntil = new Date(Date.now() + 60 * 60 * 1000); // 1h
      await BotConfig.findByIdAndUpdate(bot._id, {
        status: 'paused',
        statusMessage: `Paused 1h — 2 consecutive losses. Auto-resumes at ${pauseUntil.toLocaleTimeString()}.`,
        cooldownUntil: pauseUntil,
        'stats.consecutiveLosses': 0,
      });
      console.log(`[SmartSignal] bot=${bot.name} paused 1h after 2 consecutive losses`);
      return signals;
    }

    // ── 5. Daily loss limit check ────────────────────────────────────────────
    const dailyLossLimit = bot.riskParams?.dailyLossLimitPercent || 5;
    const startingCapital = bot.stats?.startingCapital || bot.capitalAllocation?.totalCapital || 100;
    const currentCapital  = bot.stats?.currentCapital  || startingCapital;
    const drawdownPct     = ((startingCapital - currentCapital) / startingCapital) * 100;
    if (drawdownPct >= dailyLossLimit) {
      console.log(`[SmartSignal] bot=${bot.name} — daily loss limit reached (${drawdownPct.toFixed(1)}%)`);
      return signals;
    }

    // ── 6. Query recent signals from DB ─────────────────────────────────────
    const cutoff     = new Date(Date.now() - maxAgeMs);
    const openPairs  = new Set(openPositions.map(p => p.symbol.replace('/', '')));
    const typeFilter = marketType === 'futures' ? { $in: ['LONG', 'SHORT'] } : 'LONG';

    const dbSignals = await Signal.find({
      timestamp:       { $gte: cutoff },
      confidenceScore: { $gte: minConfidence },
      type:            typeFilter,
      marketType,
    })
      .sort({ confidenceScore: -1, timestamp: -1 })
      .limit(100)
      .lean();

    // Filter out pairs already in open positions
    const candidates = dbSignals.filter(s =>
      s.entry && s.stopLoss && s.takeProfit &&
      !openPairs.has(s.pair.replace('/', ''))
    );

    // ── 7. Score and rank signals ─────────────────────────────────────────────
    const executionMode = bot.executionMode || 'auto';
    const ranked = scoringEngine.rankSignals(candidates, executionMode === 'manual' ? 3 : 10);

    console.log(
      `[SmartSignal] bot=${bot.name} mode=${executionMode} market=${marketType} ` +
      `minConf=${(minConfidence * 100).toFixed(0)}% window=${ageMin}min ` +
      `→ ${candidates.length} candidate(s), ${ranked.length} qualified (score≥${scoringEngine.MIN_SCORE})`
    );

    // ── 8. Manual mode — store top 3 pending signals, don't execute ──────────
    if (executionMode === 'manual') {
      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h
      const pendingSignals = ranked.map(sig => ({
        signalId:        sig._id,
        pair:            sig.pair,
        type:            sig.type,
        entry:           sig.entry,
        stopLoss:        sig.stopLoss,
        takeProfit:      sig.takeProfit,
        score:           sig.score,
        breakdown:       sig.breakdown,
        reasons:         sig.reasons || [],
        confidenceScore: sig.confidenceScore,
        marketType:      sig.marketType,
        expiresAt,
      }));

      await BotConfig.findByIdAndUpdate(bot._id, { pendingSignals });

      if (pendingSignals.length > 0) {
        console.log(`[SmartSignal] bot=${bot.name} — ${pendingSignals.length} pending signal(s) queued for manual review`);
      }
      return signals; // no auto execution
    }

    // ── 9. Auto mode — execute the single best signal ────────────────────────
    const best = ranked[0];
    if (!best) {
      console.log(`[SmartSignal] bot=${bot.name} — no signals met score threshold this tick`);
      return signals;
    }

    const tradeSymbol = best.pair.replace('/', '');

    // Fetch live price for accurate position sizing
    let livePrice = best.entry;
    try {
      const ticker = await marketDataService.fetchTicker(tradeSymbol, marketType);
      livePrice = ticker.lastPrice;
    } catch {
      console.warn(`[SmartSignal] Could not fetch live price for ${tradeSymbol}, using signal entry`);
    }

    // Price drift guard
    const drift = Math.abs(livePrice - best.entry) / best.entry * 100;
    if (drift > MAX_PRICE_DRIFT_PCT) {
      console.log(
        `[SmartSignal] Skipping ${tradeSymbol} — price drifted ${drift.toFixed(2)}% ` +
        `from signal entry $${best.entry} → live $${livePrice}`
      );
      return signals;
    }

    // ATR-based position sizing: maxLoss / SL_distance = units to buy
    const isShortSig  = best.type === 'SHORT';
    const slDistance  = Math.abs(livePrice - best.stopLoss);
    const maxLoss     = capital * (finalRiskPct / 100);
    const amount      = slDistance > 0 ? maxLoss / slDistance : (capital * finalRiskPct / 100 * leverage) / livePrice;

    if (!isFinite(amount) || amount <= 0) return signals;

    // Ladder TP1 at 1:1 R:R
    const riskDist = isShortSig
      ? best.stopLoss - best.entry
      : best.entry - best.stopLoss;
    const tp1Price = riskDist > 0
      ? (isShortSig ? best.entry - riskDist : best.entry + riskDist)
      : null;

    // Set cooldown after entry
    const cooldownMs = (bot.cooldownMinutes || 30) * 60 * 1000;
    await BotConfig.findByIdAndUpdate(bot._id, {
      cooldownUntil: new Date(Date.now() + cooldownMs),
      pendingSignals: [],
    });

    signals.push({
      action:          'buy',
      symbol:          tradeSymbol,
      side:            isShortSig ? 'short' : 'long',
      portionIndex:    openPositions.length,
      amount,
      takeProfitPrice: best.takeProfit,
      stopLossPrice:   best.stopLoss,
      tp1Price,
      reason:          'smart_signal',
      confidence:      best.confidenceScore,
      score:           best.score,
    });

    console.log(
      `[SmartSignal] → AUTO executing ${best.type} ${tradeSymbol} ` +
      `score=${best.score} entry=$${best.entry} live=$${livePrice} drift=${drift.toFixed(2)}% ` +
      `amount=${amount.toFixed(6)} conf=${(best.confidenceScore * 100).toFixed(0)}%`
    );

    return signals;
  }
}

export default new SmartSignalStrategy();
