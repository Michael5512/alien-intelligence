const axios = require('axios');
const CONFIG = require('../utils/config');

async function getTokenMeta(mintAddress) {
  try {
    const res = await axios.post(CONFIG.HELIUS_RPC, {
      jsonrpc: '2.0',
      id: 'alien-meta',
      method: 'getAsset',
      params: { id: mintAddress },
    });
    return res.data?.result || null;
  } catch (err) {
    console.error('[filters] getTokenMeta error:', err.message);
    return null;
  }
}

async function getDexData(mintAddress) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
      { timeout: 8000 }
    );
    const pairs = res.data?.pairs;
    if (!pairs || pairs.length === 0) return null;
    const solanaPairs = pairs.filter(p => p.chainId === 'solana');
    if (!solanaPairs.length) return null;
    return solanaPairs.sort((a, b) =>
      (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0];
  } catch (err) {
    console.error('[filters] getDexData error:', err.message);
    return null;
  }
}

/**
 * Get real holder count via Helius getTokenAccounts
 * Returns actual total, not capped at 20
 */
async function getRealHolderCount(mintAddress) {
  try {
    let page = 1;
    let totalHolders = 0;

    while (true) {
      const res = await axios.post(
        `https://mainnet.helius-rpc.com/?api-key=${CONFIG.HELIUS_API_KEY}`,
        {
          jsonrpc: '2.0',
          id: `holders-${page}`,
          method: 'getTokenAccounts',
          params: {
            mint: mintAddress,
            limit: 1000,
            page,
          },
        },
        { timeout: 10000 }
      );

      const accounts = res.data?.result?.token_accounts || [];
      // Only count accounts with balance > 0
      const active = accounts.filter(a => a.amount && Number(a.amount) > 0);
      totalHolders += active.length;

      // If less than 1000 returned, we've hit the end
      if (accounts.length < 1000) break;

      // Safety cap — don't paginate forever
      if (page >= 10) break;
      page++;
    }

    return totalHolders;
  } catch (err) {
    console.error('[filters] getRealHolderCount error:', err.message);
    return 0;
  }
}

/**
 * Get top holder percentage using getTokenLargestAccounts
 */
async function getTopHolderPercent(mintAddress) {
  try {
    const res = await axios.post(CONFIG.HELIUS_RPC, {
      jsonrpc: '2.0',
      id: 'top-holders',
      method: 'getTokenLargestAccounts',
      params: [mintAddress],
    });
    const accounts = res.data?.result?.value || [];
    if (!accounts.length) return 0;
    const totalSupply = accounts.reduce((s, h) => s + Number(h.amount), 0);
    const topAmount = Number(accounts[0].amount);
    return totalSupply > 0 ? (topAmount / totalSupply) * 100 : 0;
  } catch (err) {
    console.error('[filters] getTopHolderPercent error:', err.message);
    return 0;
  }
}

async function runFilters(mintAddress, userFilters = {}) {
  const filters = { ...CONFIG.DEFAULT_FILTERS, ...userFilters };
  const reasons = [];
  const warnings = [];

  const [dex, meta, holderCount, topHolderPercent] = await Promise.all([
    getDexData(mintAddress),
    getTokenMeta(mintAddress),
    getRealHolderCount(mintAddress),
    getTopHolderPercent(mintAddress),
  ]);

  if (!dex) {
    return {
      pass: false,
      reasons: ['❌ No DEX pair found — token may not be listed yet'],
      warnings: [],
      data: null,
    };
  }

  const liquidity = dex.liquidity?.usd || 0;
  const buyTax = dex.info?.buyTax || 0;
  const sellTax = dex.info?.sellTax || 0;
  const pairCreatedAt = dex.pairCreatedAt || 0;
  const txns = dex.txns?.h1 || {};
  const buys = txns.buys || 0;
  const sells = txns.sells || 0;
  const totalTxns = buys + sells;
  const buyRatio = totalTxns > 0 ? (buys / totalTxns) * 100 : 0;
  const tokenAgeSecs = pairCreatedAt ? (Date.now() - pairCreatedAt) / 1000 : 0;

  // ── Filter checks ─────────────────────────────────────────────
  if (liquidity < filters.minLiquidity)
    reasons.push(`❌ Liquidity $${liquidity.toFixed(0)} < min $${filters.minLiquidity}`);

  if (tokenAgeSecs < filters.minTokenAgeSecs)
    reasons.push(`❌ Token age ${Math.floor(tokenAgeSecs)}s < min ${filters.minTokenAgeSecs}s`);

  if (buyRatio < filters.minBuyRatio)
    reasons.push(`❌ Buy ratio ${buyRatio.toFixed(1)}% < min ${filters.minBuyRatio}%`);

  if (buyTax > filters.maxBuyTax)
    reasons.push(`❌ Buy tax ${buyTax}% > max ${filters.maxBuyTax}%`);

  if (sellTax > filters.maxSellTax)
    reasons.push(`❌ Sell tax ${sellTax}% > max ${filters.maxSellTax}%`);

  if (topHolderPercent > filters.maxTopHolderPercent)
    reasons.push(`❌ Top holder ${topHolderPercent.toFixed(1)}% > max ${filters.maxTopHolderPercent}%`);

  if (holderCount < filters.minHolderCount)
    warnings.push(`⚠️ Only ${holderCount} holders (min ${filters.minHolderCount})`);

  if (meta) {
    if (filters.mintAuthorityRevoked && meta.mintAuthority)
      reasons.push('❌ Mint authority NOT revoked — rug risk');
    if (filters.freezeAuthorityRevoked && meta.freezeAuthority)
      reasons.push('❌ Freeze authority NOT revoked — rug risk');
  }

  return {
    pass: reasons.length === 0,
    reasons,
    warnings,
    data: {
      name: dex.baseToken?.name || 'Unknown',
      symbol: dex.baseToken?.symbol || '???',
      price: dex.priceUsd || '0',
      liquidity,
      marketCap: dex.marketCap || 0,
      buyRatio: buyRatio.toFixed(1),
      buys,
      sells,
      buyTax,
      sellTax,
      tokenAgeSecs: Math.floor(tokenAgeSecs),
      holderCount,
      topHolderPercent: topHolderPercent.toFixed(1),
      dexUrl: dex.url || `https://dexscreener.com/solana/${mintAddress}`,
      pairAddress: dex.pairAddress,
      mintAuthority: meta?.mintAuthority || null,
      freezeAuthority: meta?.freezeAuthority || null,
    },
  };
}

module.exports = { runFilters, getDexData, getTokenMeta };
