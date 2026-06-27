const WebSocket = require('ws');
const CONFIG = require('../utils/config');

// Raydium AMM program IDs to monitor
const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

let wsInstance = null;
let reconnectTimer = null;
const migratedTokens = new Set();

/**
 * Start Helius WebSocket listener for Raydium pool creation
 * Detects Pump.fun migrations in ~100-500ms vs 20-60s polling
 */
function startMigrationListener(onMigration) {
  const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${CONFIG.HELIUS_API_KEY}`;

  function connect() {
    console.log('[migration] Connecting to Helius WebSocket...');
    wsInstance = new WebSocket(wsUrl);

    wsInstance.on('open', () => {
      console.log('[migration] ✅ WebSocket connected — watching Raydium pools');

      // Subscribe to Raydium AMM v4 logs
      wsInstance.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [
          { mentions: [RAYDIUM_AMM_V4] },
          { commitment: 'confirmed' },
        ],
      }));

      // Subscribe to Raydium CPMM logs
      wsInstance.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'logsSubscribe',
        params: [
          { mentions: [RAYDIUM_CPMM] },
          { commitment: 'confirmed' },
        ],
      }));
    });

    wsInstance.on('message', async (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        const logs = data?.params?.result?.value?.logs || [];
        const signature = data?.params?.result?.value?.signature;

        if (!signature || !logs.length) return;

        // Check if this is a pool initialization
        const isInit = logs.some(l =>
          l.includes('initialize2') ||
          l.includes('InitializePool') ||
          l.includes('initialize')
        );

        if (!isInit) return;

        // Parse mint from logs
        const mintLog = logs.find(l => l.includes('mint'));
        if (!mintLog) return;

        // Extract mint address from transaction
        await parseMigrationTx(signature, onMigration);
      } catch (err) {
        // Silent — high volume of messages
      }
    });

    wsInstance.on('error', (err) => {
      console.error('[migration] WebSocket error:', err.message);
    });

    wsInstance.on('close', () => {
      console.log('[migration] WebSocket closed — reconnecting in 5s...');
      reconnectTimer = setTimeout(connect, 5000);
    });
  }

  connect();
}

/**
 * Fetch and parse the migration transaction to get token details
 */
async function parseMigrationTx(signature, onMigration) {
  const axios = require('axios');

  try {
    const res = await axios.post(CONFIG.HELIUS_RPC, {
      jsonrpc: '2.0',
      id: 'migration-tx',
      method: 'getTransaction',
      params: [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ],
    });

    const tx = res.data?.result;
    if (!tx) return;

    // Find the new token mint from postTokenBalances
    const tokenBalances = tx.meta?.postTokenBalances || [];
    if (!tokenBalances.length) return;

    // Get unique mints in this transaction
    const mints = [...new Set(tokenBalances.map(b => b.mint))];

    for (const mint of mints) {
      if (migratedTokens.has(mint)) continue;

      // Skip SOL/WSOL/USDC
      const skipMints = [
        'So11111111111111111111111111111111111111112',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      ];
      if (skipMints.includes(mint)) continue;

      migratedTokens.add(mint);

      // Get token info from DexScreener (just for display — we already detected it fast)
      try {
        const dexRes = await axios.get(
          `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
          { timeout: 6000 }
        );
        const pairs = dexRes.data?.pairs?.filter(p => p.chainId === 'solana') || [];
        const pair = pairs[0];

        await onMigration({
          mint,
          name: pair?.baseToken?.name || 'Unknown',
          symbol: pair?.baseToken?.symbol || mint.slice(0, 6),
          price: pair?.priceUsd || '0',
          liquidity: pair?.liquidity?.usd || 0,
          marketCap: pair?.marketCap || 0,
          dexUrl: pair?.url || `https://dexscreener.com/solana/${mint}`,
          signature,
          fresh: true, // WebSocket = detected at birth
        });
      } catch {
        // Fire with minimal data if DexScreener slow
        await onMigration({
          mint,
          name: 'Unknown',
          symbol: mint.slice(0, 6),
          price: '0',
          liquidity: 0,
          marketCap: 0,
          dexUrl: `https://dexscreener.com/solana/${mint}`,
          signature,
          fresh: true,
        });
      }
    }

    // Prune seen list
    if (migratedTokens.size > 2000) {
      const arr = [...migratedTokens];
      migratedTokens.clear();
      arr.slice(arr.length - 1000).forEach(m => migratedTokens.add(m));
    }
  } catch (err) {
    console.error('[migration] parseMigrationTx error:', err.message);
  }
}

/**
 * Stop the WebSocket listener
 */
function stopMigrationListener() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (wsInstance) {
    wsInstance.removeAllListeners();
    wsInstance.close();
    wsInstance = null;
  }
  console.log('[migration] WebSocket stopped');
}

module.exports = { startMigrationListener, stopMigrationListener };
