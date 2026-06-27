const axios = require('axios');
const CONFIG = require('../utils/config');

/**
 * Detect bundled buys using postTokenBalances
 * Much more accurate than signer detection
 */
async function detectBundledBuys(mintAddress) {
  try {
    // Get first 50 signatures for this mint
    const sigRes = await axios.post(CONFIG.HELIUS_RPC, {
      jsonrpc: '2.0',
      id: 'bundle-sigs',
      method: 'getSignaturesForAddress',
      params: [mintAddress, { limit: 50 }],
    });

    const sigs = sigRes.data?.result || [];
    if (!sigs.length) return { bundled: false, details: null };

    // Get earliest transactions (launch window)
    const earliest = sigs.slice(-15).map(s => s.signature);

    // Fetch full transaction details
    const txRes = await axios.post(CONFIG.HELIUS_RPC, {
      jsonrpc: '2.0',
      id: 'bundle-txs',
      method: 'getTransactions',
      params: [
        earliest,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ],
    });

    const txs = txRes.data?.result || [];

    // Group unique token recipients by slot using postTokenBalances
    const slotMap = {};

    for (const tx of txs) {
      if (!tx || !tx.meta) continue;
      const slot = tx.slot;

      // Use postTokenBalances to find actual token recipients
      const recipients = tx.meta.postTokenBalances
        ?.filter(b =>
          b.mint === mintAddress &&
          b.uiTokenAmount?.uiAmount > 0
        )
        ?.map(b => b.owner) || [];

      if (!slotMap[slot]) slotMap[slot] = new Set();
      recipients.forEach(r => slotMap[slot].add(r));
    }

    // Find peak unique recipients in a single block
    let maxSameBlock = 0;
    let bundleSlot = null;

    for (const [slot, owners] of Object.entries(slotMap)) {
      if (owners.size > maxSameBlock) {
        maxSameBlock = owners.size;
        bundleSlot = slot;
      }
    }

    // 3+ unique wallets receiving tokens in same block = bundle signal
    const bundled = maxSameBlock >= 3;

    return {
      bundled,
      details: {
        maxWalletsInOneBlock: maxSameBlock,
        slot: bundleSlot,
        risk: maxSameBlock >= 6 ? 'HIGH' : maxSameBlock >= 3 ? 'MEDIUM' : 'LOW',
      },
    };
  } catch (err) {
    console.error('[bundlecheck] error:', err.message);
    return { bundled: false, details: null, error: err.message };
  }
}

module.exports = { detectBundledBuys };
