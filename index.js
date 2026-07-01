require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const cron = require('node-cron');
const axios = require('axios');
const CONFIG = require('./utils/config');
const { setupCommands } = require('./bot/commands');
const { monitorPosition, activePositions, sellToken } = require('./sniper/solana');
const { runFilters } = require('./sniper/filters');
const { checkDevWallets, startDevWatch } = require('./sniper/devwatch');
const { startMigrationListener, stopMigrationListener } = require('./sniper/migration');
const { logEntry, logExit } = require('./db/tradeHistory');
const { scoreToken } = require('./sniper/scorer');
const apiRouter = require('./api/server');

// ── Validate env ──────────────────────────────────────────────────
const required = ['TELEGRAM_TOKEN', 'OWNER_TELEGRAM_ID', 'HELIUS_API_KEY', 'OWNER_PRIVATE_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[boot] ❌ Missing env var: ${key}`);
    process.exit(1);
  }
}

// ── Bot init ──────────────────────────────────────────────────────
const bot = new Telegraf(CONFIG.TELEGRAM_TOKEN);
const { getAutoSnipeEnabled, initSettings } = setupCommands(bot);

// ── Notify owner ─────────────────────────────────────────────────
async function notifyOwner(message) {
  try {
    await bot.telegram.sendMessage(CONFIG.OWNER_TELEGRAM_ID, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('[notify] Failed:', err.message);
  }
}

// ── Migration handler ─────────────────────────────────────────────
async function handleMigration(token) {
  if (!getAutoSnipeEnabled()) {
    return notifyOwner(
      `🚀 *MIGRATION DETECTED* — ${token.symbol}\n` +
      `Auto-snipe is OFF. Use /snipe ${token.mint} to enter.\n` +
      `[Chart](${token.dexUrl})`
    );
  }

  await notifyOwner(
    `🚀 *PUMP.FUN MIGRATION*\n\n` +
    `*${token.name} (${token.symbol})*\n` +
    `Liquidity: $${token.liquidity.toLocaleString()}\n` +
    `[Chart](${token.dexUrl})\n\n` +
    `⚡ Running filters...`
  );

  const { pass, data, reasons } = await runFilters(token.mint);

  if (!pass) {
    return notifyOwner(
      `❌ ${token.symbol} failed filters\n` +
      reasons.slice(0, 3).join('\n')
    );
  }

  const score = await scoreToken(token.mint, {
    liquidity: data.liquidity,
    holderCount: data.holderCount,
    buyRatio: data.buyRatio,
    tokenAgeSecs: data.tokenAgeSecs,
    buyTax: data.buyTax,
    sellTax: data.sellTax,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    topHolderPercent: 0,
  }, 'momentum');

  await notifyOwner(
    `✅ Filters passed — ${token.symbol}\n` +
    `Conviction: ${score.score}/100 ${score.emoji}\n` +
    `Executing ${CONFIG.DEFAULT_FILTERS.buyAmountSol} SOL snipe...`
  );

  const { executeSwap } = require('./sniper/solana');
  executeSwap(token.mint, CONFIG.DEFAULT_FILTERS.buyAmountSol)
    .then(async ({ txid, amountOut }) => {
      const entryPrice = parseFloat(token.price) || 0;
      activePositions.set(token.mint, {
        symbol: token.symbol,
        entryPrice,
        tokenAmount: amountOut,
        takeProfitPercent: CONFIG.DEFAULT_FILTERS.takeProfitPercent,
        stopLossPercent: CONFIG.DEFAULT_FILTERS.stopLossPercent,
        boughtAt: Date.now(),
        solSpent: CONFIG.DEFAULT_FILTERS.buyAmountSol,
      });

      await logEntry({
        mint: token.mint,
        symbol: token.symbol,
        entryPrice,
        solSpent: CONFIG.DEFAULT_FILTERS.buyAmountSol,
        tokenAmount: amountOut,
        txidEntry: txid,
        convictionScore: score.score,
      });

      await startDevWatch(token.mint, token.symbol, notifyOwner, false);

      notifyOwner(
        `🟢 *MIGRATION SNIPE DONE* — ${token.symbol}\n` +
        `TX: \`${txid}\`\n` +
        `[Solscan](https://solscan.io/tx/${txid})`
      );
    })
    .catch(err => {
      notifyOwner(`❌ Migration snipe failed: ${err.message}`);
    });
}

// ── TP/SL + Dev Watch — every 30s ────────────────────────────────
cron.schedule('*/30 * * * * *', async () => {
  if (activePositions.size > 0) {
    for (const [mint] of activePositions) {
      await monitorPosition(mint, async (msg, exitData) => {
        notifyOwner(msg);
        if (exitData) {
          await logExit({
            mint,
            exitPrice: exitData.exitPrice,
            solReturned: exitData.solReturned,
            exitReason: exitData.reason,
            txidExit: exitData.txid,
          });
        }
      });
    }
  }
  await checkDevWallets(activePositions, sellToken);
});

// ── Auto-snipe poller — every 3 minutes ──────────────────────────
// Reduced from 60s to 3min to stay within Helius free tier limits
let seenPairs = new Set();

cron.schedule('*/3 * * * *', async () => {
  if (!getAutoSnipeEnabled()) return;

  try {
    // Add delay before API call
    await new Promise(r => setTimeout(r, 2000));

    const res = await axios.get(
      `https://api.helius.xyz/v0/addresses/675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8/transactions?api-key=${CONFIG.HELIUS_API_KEY}&limit=25&type=SWAP`,
      { timeout: 10000 }
    );

    const txs = res.data || [];
    if (!Array.isArray(txs)) return;

    const skipMints = new Set([
      'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    ]);

    const mints = new Set();
    for (const tx of txs) {
      for (const transfer of (tx.tokenTransfers || [])) {
        const mint = transfer.mint;
        if (mint && !skipMints.has(mint) && !seenPairs.has(mint)) {
          mints.add(mint);
        }
      }
    }

    if (!mints.size) {
      console.log('[autosnipe] No new tokens this cycle');
      return;
    }

    console.log(`[autosnipe] Checking ${mints.size} tokens...`);
    let passed = 0;

    for (const mint of mints) {
      seenPairs.add(mint);

      // Delay between each filter check to avoid rate limiting
      await new Promise(r => setTimeout(r, 1500));

      const { pass, data } = await runFilters(mint);
      if (!pass) continue;

      passed++;
      console.log(`[autosnipe] ✅ ${data.symbol} passed filters`);

      const score = await scoreToken(mint, {
        liquidity: data.liquidity,
        holderCount: data.holderCount,
        buyRatio: data.buyRatio,
        tokenAgeSecs: data.tokenAgeSecs,
        buyTax: data.buyTax,
        sellTax: data.sellTax,
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        topHolderPercent: 0,
      }, 'safety');

      await notifyOwner(
        `🛸 *AUTO-SNIPE TRIGGERED*\n\n` +
        `*${data.name} (${data.symbol})*\n` +
        `Price: $${parseFloat(data.price).toFixed(8)}\n` +
        `Liquidity: $${data.liquidity.toLocaleString()}\n` +
        `Conviction: ${score.score}/100 ${score.emoji}\n` +
        `Executing ${CONFIG.DEFAULT_FILTERS.buyAmountSol} SOL...`
      );

      const { executeSwap } = require('./sniper/solana');
      executeSwap(mint, CONFIG.DEFAULT_FILTERS.buyAmountSol)
        .then(async ({ txid, amountOut }) => {
          const entryPrice = parseFloat(data.price);
          activePositions.set(mint, {
            symbol: data.symbol,
            entryPrice,
            tokenAmount: amountOut,
            takeProfitPercent: CONFIG.DEFAULT_FILTERS.takeProfitPercent,
            stopLossPercent: CONFIG.DEFAULT_FILTERS.stopLossPercent,
            boughtAt: Date.now(),
            solSpent: CONFIG.DEFAULT_FILTERS.buyAmountSol,
          });

          await logEntry({
            mint,
            symbol: data.symbol,
            entryPrice,
            solSpent: CONFIG.DEFAULT_FILTERS.buyAmountSol,
            tokenAmount: amountOut,
            txidEntry: txid,
            convictionScore: score.score,
          });

          await startDevWatch(mint, data.symbol, notifyOwner, false);

          notifyOwner(
            `✅ *SNIPED* — ${data.symbol}\n` +
            `TX: \`${txid}\`\n` +
            `[Solscan](https://solscan.io/tx/${txid})`
          );
        })
        .catch(err => {
          notifyOwner(`❌ Auto-snipe failed for ${data.symbol}: ${err.message}`);
        });
    }

    console.log(`[autosnipe] Cycle done — ${passed} passed filters`);

    if (seenPairs.size > 2000) {
      const arr = [...seenPairs];
      seenPairs = new Set(arr.slice(arr.length - 1000));
    }
  } catch (err) {
    console.error('[autosnipe] Poll error:', err.message);
  }
});

// ── API Server ────────────────────────────────────────────────────
function startApiServer() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  global.getAutoSnipeEnabled = getAutoSnipeEnabled;
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[api] ✅ API server running on port ${PORT}`);
  });
}

// ── MongoDB ───────────────────────────────────────────────────────
async function connectDB() {
  if (!CONFIG.MONGODB_URI) {
    console.log('[db] No MONGODB_URI — running in-memory');
    return;
  }
  try {
    await mongoose.connect(CONFIG.MONGODB_URI);
    console.log('[db] ✅ MongoDB connected');
  } catch (err) {
    console.error('[db] ❌ MongoDB failed:', err.message);
  }
}

// ── Launch ────────────────────────────────────────────────────────
async function main() {
  await connectDB();
  await initSettings();

  bot.launch({ dropPendingUpdates: true });

  startApiServer();
  startMigrationListener(handleMigration);

  console.log(`[boot] ✅ Alien Intelligence — Phase ${CONFIG.PHASE} online`);
  console.log(`[boot] TP/SL + Dev Watch: every 30s`);
  console.log(`[boot] Auto-snipe poller: every 3 minutes (rate-limit safe)`);
  console.log(`[boot] Migration listener: Helius WebSocket active`);

  await notifyOwner(
    `👾 *ALIEN INTELLIGENCE — Online*\n\n` +
    `Phase 1 fully loaded 🟢\n\n` +
    `✅ Safety filters\n` +
    `✅ Bundle buy detector\n` +
    `✅ Dev wallet tracker\n` +
    `✅ Migration listener (WebSocket ⚡)\n` +
    `✅ Conviction scoring\n` +
    `✅ Trade history\n` +
    `✅ Settings persistence\n` +
    `✅ API server active\n` +
    `✅ Rate-limit safe mode\n\n` +
    `Type /start for commands.`
  );
}

process.once('SIGINT', () => {
  stopMigrationListener();
  bot.stop('SIGINT');
  mongoose.disconnect();
});
process.once('SIGTERM', () => {
  stopMigrationListener();
  bot.stop('SIGTERM');
  mongoose.disconnect();
});

main().catch(err => {
  console.error('[boot] Fatal:', err);
  process.exit(1);
});
