/**
 * PairConflictGuard
 *
 * Checks whether a user already has an open position on a given pair
 * across ALL their bots. Returns conflict info so the caller can warn
 * the user before opening another trade on the same pair.
 */

import Position from '../models/bot/Position.js';
import BotConfig from '../models/bot/BotConfig.js';

/**
 * Check if a user has any open position for a given symbol.
 *
 * @param {string} userId
 * @param {string} symbol  — e.g. "BTCUSDT" or "BTC/USDT"
 * @param {string} [excludeBotId] — bot to exclude from check (e.g. the bot about to trade)
 * @returns {{ hasConflict: boolean, botName: string|null, positionSide: string|null, positionId: string|null }}
 */
async function checkPairConflict(userId, symbol, excludeBotId = null) {
  const normalized = symbol.replace('/', '').toUpperCase();

  // Get all bot IDs belonging to this user
  const query = { userId };
  if (excludeBotId) query._id = { $ne: excludeBotId };
  const userBots = await BotConfig.find(query, '_id name').lean();
  const botIds   = userBots.map(b => b._id);

  if (botIds.length === 0) return { hasConflict: false, botName: null, positionSide: null, positionId: null };

  // Find any open position on this symbol across all bots
  const conflict = await Position.findOne({
    botId:  { $in: botIds },
    symbol: normalized,
    status: 'open',
  }).lean();

  if (!conflict) return { hasConflict: false, botName: null, positionSide: null, positionId: null };

  const bot = userBots.find(b => b._id.toString() === conflict.botId.toString());
  return {
    hasConflict:  true,
    botName:      bot?.name || 'Another bot',
    positionSide: conflict.side,
    positionId:   conflict._id.toString(),
  };
}

export default { checkPairConflict };
