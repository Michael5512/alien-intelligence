const axios = require('axios');
const CONFIG = require('../utils/config');

// devWatches: { mintAddress: { devWallet, initialBalance, symbol, notifyFn, autoSell } }
const devWatches = new Map();

/**
 * Identify the dev wallet — largest holder at launch
 * Uses Helius getTokenLargestAccounts
 */
async function identifyDevWallet(mintAddress) {
  try {
    const res = await axios.post(CONFIG.HELIUS_RPC, {
      jsonrpc: '2.0',
      id: 'dev-detect',
      method: 'getTokenLargestAccounts',
      params: [mintAddress],
    });

    const accounts = res.data?.result?.value || [];
    if (!accounts.length) return null;

    // Largest holder = most likely dev
    const top = accounts[0];
    return {
      address: top.address,
      amount: Number(top.amount),
      uiAmount: top.uiAmount,
    };
  } catch (err) {
    console.error('[devwatch] identifyDevWallet error:', err.message);
    return null;
  }
}

/**
 * Get current token balance of a wallet
 */
async function getWalletTokenBalance(walletAddress, mintAddress) {
  try {
    const res = await axios.post(CONFIG.HELIUS_RPC, {
      jsonrpc: '2.0',
      id: 'dev-balance',
      method: 'getTokenAccountsByOwner',
      params: [
        walletAddress,
        { mint: mintAddress },
        { encoding: 'jsonParsed' },
      ],
    });

    const accounts = res.data?.result?.value || [];
    if (!accounts.length) return 0;

    const balance = accounts[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
    return balance;
  } catch (err) {
    console.error('[devwatch] getWalletTokenBalance error:', err.message);
    return null;
  }
}

/**
 * Start watching a dev wallet after a snipe
 */
async function startDevWatch(mintAddress, symbol, notifyFn, autoSell = false) {
  const dev = await identifyDevWallet(mintAddress);

  if (!dev) {
    notifyFn(`⚠️ *Dev Watch* — Could not identify dev wallet for ${symbol}`);
    return;
  }

  devWatches.set(mintAddress, {
    devWallet: dev.address,
    initialBalance: dev.uiAmount,
    lastBalance: dev.uiAmount,
    symbol,
    notifyFn,
    autoSell,
    alertedAt: null,
  });

  notifyFn(
    `👁️ *Dev Watch Active* — ${symbol}\n` +
    `Dev wallet: \`${dev.address.slice(0, 8)}...${dev.address.slice(-6)}\`\n` +
    `Holding: ${dev.uiAmount?.toLocaleString()} tokens\n` +
    `Auto-sell on move: ${autoSell ? '✅ ON' : '❌ OFF'}`
  );
}

/**
 * Stop watching a dev wallet (called after position closes)
 */
function stopDevWatch(mintAddress) {
  devWatches.delete(mintAddress);
}

/**
 * Check all active dev watches — called by cron every 30s
 * If dev balance drops >10%, fire alert
 */
async function checkDevWallets(activePositions, sellTokenFn) {
  if (devWatches.size === 0) return;

  for (const [mint, watch] of devWatches) {
    try {
      const currentBalance = await getWalletTokenBalance(watch.devWallet, mint);
      if (currentBalance === null) continue;

      const { lastBalance, initialBalance, symbol, notifyFn, autoSell, alertedAt } = watch;

      // Skip if already alerted in last 5 min
      if (alertedAt && Date.now() - alertedAt < 5 * 60 * 1000) continue;

      const dropped = lastBalance - currentBalance;
      const dropPct = lastBalance > 0 ? (dropped / lastBalance) * 100 : 0;

      // Update last known balance
      devWatches.get(mint).lastBalance = currentBalance;

      // Trigger if dev sold >10% of their holdings
      if (dropPct >= 10) {
        devWatches.get(mint).alertedAt = Date.now();

        const message =
          `🚨 *DEV WALLET MOVING* — ${symbol}\n\n` +
          `Dev sold ${dropPct.toFixed(1)}% of holdings\n` +
          `Was: ${lastBalance?.toLocaleString()} → Now: ${currentBalance?.toLocaleString()}\n` +
          `Wallet: \`${watch.devWallet.slice(0, 8)}...${watch.devWallet.slice(-6)}\`\n\n` +
          (autoSell
            ? '🤖 Auto-selling your position...'
            : '⚠️ Consider exiting. Use /pnl to check.');

        notifyFn(message);

        // Auto-sell if enabled
        if (autoSell && activePositions.has(mint)) {
          const pos = activePositions.get(mint);
          try {
            const { txid } = await sellTokenFn(mint, pos.tokenAmount);
            activePositions.delete(mint);
            stopDevWatch(mint);
            notifyFn(
              `✅ *Auto-sold* — ${symbol}\n` +
              `Dev move triggered exit.\n` +
              `TX: \`${txid}\``
            );
          } catch (err) {
            notifyFn(`❌ Auto-sell failed for ${symbol}: ${err.message}`);
          }
        }
      }

      // Full dump alert — dev at 0
      if (currentBalance === 0 && lastBalance > 0) {
        devWatches.get(mint).alertedAt = Date.now();
        notifyFn(
          `💀 *DEV DUMPED* — ${symbol}\n\n` +
          `Dev wallet is now at 0 tokens.\n` +
          `Exit immediately if still holding.`
        );
      }
    } catch (err) {
      console.error(`[devwatch] check error for ${mint}:`, err.message);
    }
  }
}

module.exports = {
  startDevWatch,
  stopDevWatch,
  checkDevWallets,
  identifyDevWallet,
  devWatches,
};
