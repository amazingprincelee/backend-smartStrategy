/**
 * SignalScoringEngine
 *
 * Scores DB signals on 4 weighted factors and returns a ranked list.
 * Only signals with composite score >= MIN_SCORE qualify for trading.
 *
 * Weights:
 *   MTF Alignment    35%
 *   Confidence       25%
 *   Momentum         25%  (RSI + MACD from reasons[])
 *   Volume           15%
 */

const MIN_SCORE = 65; // minimum composite score to qualify (0–100)

/**
 * Score a single signal. Returns { score, breakdown } where score is 0–100.
 */
function scoreSignal(sig) {
  // ── 1. MTF Alignment (35 pts) ───────────────────────────────────────────
  let mtfScore = 0;
  const mtf = sig.mtfAlignment;
  if (mtf && typeof mtf === 'object') {
    const values   = Object.values(mtf);
    const total    = values.length;
    const aligned  = values.filter(v => v === 'bullish' || v === 'bearish').length;
    mtfScore = total > 0 ? (aligned / total) * 35 : 17; // neutral if no data
  } else {
    mtfScore = 17; // no MTF data — give half weight
  }

  // ── 2. Confidence (25 pts) ──────────────────────────────────────────────
  const confScore = (sig.confidenceScore || 0) * 25;

  // ── 3. Momentum (25 pts) — RSI + MACD mentions in reasons[] ────────────
  const reasons = (sig.reasons || []).map(r => r.toLowerCase());
  let momentumScore = 0;

  // RSI contribution (12.5 pts max)
  const hasRsiStrong = reasons.some(r => r.includes('deeply') && r.includes('rsi'));
  const hasRsiNormal = reasons.some(r => r.includes('rsi'));
  if (hasRsiStrong) momentumScore += 12.5;
  else if (hasRsiNormal) momentumScore += 7;

  // MACD contribution (12.5 pts max)
  const hasMacdMomentum = reasons.some(r => r.includes('histogram') && r.includes('macd'));
  const hasMacdBasic    = reasons.some(r => r.includes('macd'));
  if (hasMacdMomentum) momentumScore += 12.5;
  else if (hasMacdBasic) momentumScore += 7;

  // ── 4. Volume (15 pts) ──────────────────────────────────────────────────
  const hasVolumeSpike = reasons.some(r => r.includes('volume spike') || r.includes('volume'));
  const volumeScore    = hasVolumeSpike ? 15 : 0;

  // ── Bonus: Risk:Reward ≥ 2 (+5 pts) ─────────────────────────────────────
  const rrBonus = (sig.riskReward || 0) >= 2 ? 5 : 0;

  const raw = mtfScore + confScore + momentumScore + volumeScore + rrBonus;
  const score = Math.min(100, Math.round(raw));

  return {
    score,
    breakdown: {
      mtf:        Math.round(mtfScore),
      confidence: Math.round(confScore),
      momentum:   Math.round(momentumScore),
      volume:     Math.round(volumeScore),
      rrBonus,
    }
  };
}

/**
 * Score and rank an array of signals.
 * Returns only signals with score >= MIN_SCORE, sorted best-first.
 *
 * @param {Array}  signals  — raw signal docs from DB
 * @param {number} limit    — max results to return (default: 10)
 * @returns {Array} scored signals: [...signal, score, breakdown]
 */
function rankSignals(signals, limit = 10) {
  return signals
    .map(sig => {
      const { score, breakdown } = scoreSignal(sig);
      return { ...sig, score, breakdown };
    })
    .filter(s => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Return the single best signal from an array (or null if none qualify).
 */
function bestSignal(signals) {
  const ranked = rankSignals(signals, 1);
  return ranked.length > 0 ? ranked[0] : null;
}

export default { rankSignals, bestSignal, scoreSignal, MIN_SCORE };
