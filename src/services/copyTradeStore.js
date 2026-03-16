/**
 * In-memory store for copy trade positions.
 * Tracks target wallet and bot buy/sell amounts per mint.
 * @module services/copyTradeStore
 */

/** @type {Map<string, { targetBought: number, targetSold: number, botBought: number, botSold: number }>} */
const positions = new Map();

/**
 * Record target wallet buy.
 * @param {string} mint
 * @param {number} rawAmount - raw token amount (base units)
 */
export function addTargetBuy(mint, rawAmount) {
  const p = positions.get(mint) ?? {
    targetBought: 0,
    targetSold: 0,
    botBought: 0,
    botSold: 0,
  };
  p.targetBought += rawAmount;
  positions.set(mint, p);
}

/**
 * Record target wallet sell.
 * @param {string} mint
 * @param {number} rawAmount - raw token amount (base units)
 */
export function addTargetSell(mint, rawAmount) {
  const p = positions.get(mint);
  if (!p) return;
  p.targetSold += rawAmount;
}

/**
 * Record bot buy.
 * @param {string} mint
 * @param {number} rawAmount - raw token amount (base units)
 */
export function addBotBuy(mint, rawAmount) {
  const p = positions.get(mint) ?? {
    targetBought: 0,
    targetSold: 0,
    botBought: 0,
    botSold: 0,
  };
  p.botBought += rawAmount;
  positions.set(mint, p);
}

/**
 * Record bot sell.
 * @param {string} mint
 * @param {number} rawAmount - raw token amount (base units)
 */
export function addBotSell(mint, rawAmount) {
  const p = positions.get(mint);
  if (!p) return;
  p.botSold += rawAmount;
}

/**
 * Compute bot sell amount for a target sell.
 * bot_sell = bot_total_bought * (target_sell_amount / target_total_bought)
 * @param {string} mint
 * @param {number} targetSellRawAmount - raw token amount target just sold
 * @returns {{ amount: number, removeAfter: boolean }} amount in raw units, removeAfter if target sold all
 */
export function computeBotSellAmount(mint, targetSellRawAmount) {
  const p = positions.get(mint);
  if (!p || p.targetBought <= 0) return { amount: 0, removeAfter: false };

  const botRemaining = p.botBought - p.botSold;
  if (botRemaining <= 0) return { amount: 0, removeAfter: false };

  const targetRemainingBeforeSell = p.targetBought - p.targetSold;
  if (targetRemainingBeforeSell <= 0) return { amount: 0, removeAfter: false };

  const proportion = targetSellRawAmount / targetRemainingBeforeSell;
  const botSellRaw = Math.floor(botRemaining * proportion);

  const targetSoldAfter = p.targetSold + targetSellRawAmount;
  const removeAfter = targetSoldAfter >= p.targetBought;

  return { amount: botSellRaw, removeAfter };
}

/**
 * Get position for mint.
 * @param {string} mint
 */
export function getPosition(mint) {
  return positions.get(mint);
}

/**
 * Remove position (target sold all).
 * @param {string} mint
 */
export function removePosition(mint) {
  positions.delete(mint);
}
