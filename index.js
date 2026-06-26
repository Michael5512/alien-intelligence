require('dotenv').config();
const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const cron = require('node-cron');
const axios = require('axios');
const CONFIG = require('./utils/config');
const { setupCommands } = require('./bot/commands');
const { monitorPosition, activePositions } = require('./sniper/solana');
const { runFilters } = require('./sniper/filters');

const required = ['TELEGRAM_TOKEN', 'OWNER_TELEGRAM_ID', 'HELIUS_API_KEY', 'OWNER_PRIVATE_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[boot] ❌ Missing env var: ${key}`);
    process.exit(1);
  }
}

const bot = new Telegraf(CONFIG.TELEGRAM_TOKEN);
const { getAutoSnipeEnabled } = setupCommands(bot);

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

// TP/SL monitor — every 30s
cron.schedule('*/30 * * * * *', async () => {
  if (activePositions.size === 0) return;
  for (const [mint] of activePositions) {
    await monitorPosition(mint, notifyOwner);
  }
});

// Auto-snipe poller — every 60s
let seenPairs = new Set();

cron.schedule('*/60 * * * * *', async () => {
  if (!getAutoSnipeEnabled()) return;

  try {
    const res = await axios.get(
      'https://api.dexscreener.com/latest/dex/pairs/solana',
      { timeout: 8000 }
    );
    const pairs = res.data?.pairs || [];

    for (const pair of pairs) {
      const mint = pair.baseToken?.address;
      if (!mint || seenPairs.has(mint)) continue;
      seenPairs.add(mint);

      const ageMs = Date.now() - (pair.pairCreatedAt || 0);
      if (ageMs > 10 * 60 * 1000) continue;

      const { pass, data } = await runFilters(mint);
      if (!pass) continue;

      await notifyOwner(
        `🛸 *AUTO-SNIPE TRIGGERED*\n\n` +
        `*${data.name} (${data.symbol})*\n` +
        `Price: $${parseFloat(data.price).toFixed(8)}\n` +
        `Liquidity: $${data.liquidity.toLocaleString()}\n` +
        `Executing snipe for ${CONFIG.DEFAULT_FILTERS.buyAmountSol} SOL...`
      );

      const { executeSwap } = require('./sniper/solana');
      executeSwap(mint, CONFIG.DEFAULT_FILTERS.buyAmountSol)
        .then(({ txid, amountOut }) => {
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
          notifyOwner(
            `✅ *AUTO-SNIPE EXECUTED* — ${data.symbol}\n` +
            `TX: \`${txid}\`\n` +
            `[Solscan](https://solscan.io/tx/${txid})`
          );
        })
        .catch(err => {
          notifyOwner(`❌ Auto-snipe failed for ${data.symbol}: ${err.message}`);
        });
    }

    if (seenPairs.size > 500) {
      const arr = [...seenPairs];
      seenPairs = new Set(arr.slice(arr.length - 500));
    }
  } catch (err) {
    console.error('[autosnipe] Poll error:', err.message);
  }
});

async function connectDB() {
  if (!CONFIG.MONGODB_URI) {
    console.log('[db] No MONGODB_URI — running in-memory (Phase 1)');
    return;
  }
  try {
    await mongoose.connect(CONFIG.MONGODB_URI);
    console.log('[db] ✅ MongoDB connected');
  } catch (err) {
    console.error('[db] ❌ MongoDB failed:', err.message);
  }
}

async function main() {
  await connectDB();

  bot.launch({ dropPendingUpdates: true });

  console.log(`[boot] ✅ Alien Intelligence — Phase ${CONFIG.PHASE} online`);
  console.log(`[boot] Owner ID: ${CONFIG.OWNER_TELEGRAM_ID}`);

  await notifyOwner(
    `👾 *ALIEN INTELLIGENCE — Online*\n\n` +
    `Phase 1 boot complete.\n` +
    `Solana mainnet active 🟢\n` +
    `Type /start for commands.`
  );
}

process.once('SIGINT', () => { bot.stop('SIGINT'); mongoose.disconnect(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); mongoose.disconnect(); });

main().catch(err => {
  console.error('[boot] Fatal:', err);
  process.exit(1);
});
