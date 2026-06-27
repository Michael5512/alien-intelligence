const { detectBundledBuys } = require('./bundlecheck');

/**
 * Score a token 0-100
 *
 * TWO MODES:
 * safety   — for standard snipes, rewards older tokens
 * momentum — for migration snipes, rewards fresh tokens
 *
 * Breakdown (safety mode):
 * Liquidity       20pts
 * Holders         20pts
 * Buy ratio       15pts
 * Bundle check    20pts  ← increased from 10
 * Authority       15pts  ← increased from 10
 * Top holder      10pts
 * (tax removed — useless on Solana)
 */
async function scoreToken(mintAddress, filterData, mode = 'safety') {
  const scores = {};

  const {
    liquidity,
    holderCount,
    buyRatio,
    tokenAgeSecs,
    mintAuthorityRevoked,
    freezeAuthorityRevoked,
    topHolderPercent,
  } = filterData;

  // ── Liquidity (0-20) ─────────────────────────────────────────
  if (liquidity >= 200000) scores.liquidity = 20;
  else if (liquidity >= 100000) scores.liquidity = 15;
  else if (liquidity >= 50000) scores.liquidity = 10;
  else if (liquidity >= 20000) scores.liquidity = 5;
  else scores.liquidity = 0;

  // ── Holder count (0-20) ──────────────────────────────────────
  if (holderCount >= 500) scores.holders = 20;
  else if (holderCount >= 200) scores.holders = 15;
  else if (holderCount >= 100) scores.holders = 10;
  else if (holderCount >= 50) scores.holders = 5;
  else scores.holders = 0;

  // ── Buy ratio (0-15) ─────────────────────────────────────────
  const ratio = parseFloat(buyRatio) || 0;
  if (ratio >= 80) scores.buyRatio = 15;
  else if (ratio >= 70) scores.buyRatio = 12;
  else if (ratio >= 60) scores.buyRatio = 8;
  else if (ratio >= 50) scores.buyRatio = 4;
  else scores.buyRatio = 0;

  // ── Authority (0-15) ─────────────────────────────────────────
  scores.authority =
    (mintAuthorityRevoked ? 8 : 0) +
    (freezeAuthorityRevoked ? 7 : 0);

  // ── Top holder concentration (0-10) ──────────────────────────
  const topPct = topHolderPercent || 100;
  if (topPct <= 3) scores.topHolder = 10;
  else if (topPct <= 5) scores.topHolder = 8;
  else if (topPct <= 10) scores.topHolder = 5;
  else if (topPct <= 20) scores.topHolder = 2;
  else scores.topHolder = 0;

  // ── Bundle check (0-20) ──────────────────────────────────────
  try {
    const { bundled, details } = await detectBundledBuys(mintAddress);
    if (!bundled) scores.bundle = 20;
    else if (details?.risk === 'MEDIUM') scores.bundle = 8;
    else scores.bundle = 0; // HIGH risk = hard penalty
  } catch {
    scores.bundle = 10; // neutral if check fails
  }

  // ── Age bonus/penalty based on mode ──────────────────────────
  // Safety mode: older = safer
  // Momentum mode: fresh migration = opportunity
  if (mode === 'momentum') {
    // Fresh token just migrated — reward it
    scores.ageBonus = tokenAgeSecs < 120 ? 10 : tokenAgeSecs < 300 ? 5 : 0;
  } else {
    // Safety mode — penalise extremely new tokens
    scores.ageBonus = tokenAgeSecs >= 600 ? 5 : tokenAgeSecs >= 300 ? 2 : 0;
  }

  // ── Total ────────────────────────────────────────────────────
  const total = Math.min(
    100,
    Object.values(scores).reduce((a, b) => a + b, 0)
  );

  // ── Grade ────────────────────────────────────────────────────
  let grade, emoji;
  if (total >= 80) { grade = 'S — HIGH CONVICTION'; emoji = '🟢'; }
  else if (total >= 65) { grade = 'A — STRONG'; emoji = '🟢'; }
  else if (total >= 50) { grade = 'B — MODERATE'; emoji = '🟡'; }
  else if (total >= 35) { grade = 'C — WEAK'; emoji = '🟠'; }
  else { grade = 'D — AVOID'; emoji = '🔴'; }

  return { score: total, grade, emoji, breakdown: scores, mode };
}

/**
 * Format score for Telegram
 */
function formatScore(scoreResult) {
  const { score, grade, emoji, breakdown, mode } = scoreResult;
  return (
    `\n\n${emoji} *Conviction Score: ${score}/100*\n` +
    `Grade: ${grade}\n` +
    `Mode: ${mode === 'momentum' ? '⚡ Momentum' : '🛡️ Safety'}\n\n` +
    `📊 *Breakdown:*\n` +
    `Liquidity: ${breakdown.liquidity}/20\n` +
    `Holders: ${breakdown.holders}/20\n` +
    `Buy ratio: ${breakdown.buyRatio}/15\n` +
    `Bundle check: ${breakdown.bundle}/20\n` +
    `Authority: ${breakdown.authority}/15\n` +
    `Top holder: ${breakdown.topHolder}/10\n` +
    `Age bonus: ${breakdown.ageBonus}/10`
  );
}

module.exports = { scoreToken, formatScore };
