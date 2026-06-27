const axios = require('axios');
const CONFIG = require('../utils/config');

/**
 * Detect bundled buys using Helius enhanced transactions API
 * More reliable than raw RPC getSignaturesForAddress
 */
async function detectBundledBuys(mintAddress) {
  try {
    // Use Helius enhanced transactions API
    const res = await axios.get(
      `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions?api-key=${CONFIG.HELIUS_API_KEY}&limit=50&type=SWAP`,
      { timeout: 10000 }
    );

    const txs = res.data || [];
    if (!txs.length) return { bundled: false, details: null };

    // Get earliest transactions (launch window)
    const earliest = txs.slice(-15);

    // Group unique token recipients by slot
    const slotMap = {};

    for (const tx of earliest) {
      const slot = tx.slot;
      if (!slot) continue;

      // Use tokenTransfers to find actual recipients
      const recipients = tx.tokenTransfers
        ?.filter(t =>
          t.mint === mintAddress &&
          t.tokenAmount > 0 &&
          t.toUserAccount
        )
        ?.map(t => t.toUserAccount) || [];

      if (!slotMap[slot]) slotMap[slot] = new Set();
      recipients.forEach(r => slotMap[slot].add(r));
    }

    // Find peak unique recipients in single block
    let maxSameBlock = 0;
    let bundleSlot = null;

    for (const [slot, owners] of Object.entries(slotMap)) {
      if (owners.size > maxSameBlock) {
        maxSameBlock = owners.size;
        bundleSlot = slot;
      }
    }

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
