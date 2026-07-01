const { Markup } = require('telegraf');
const CONFIG = require('../utils/config');
const { runFilters } = require('../sniper/filters');
const {
  executeSwap,
  sellToken,
  getCurrentPrice,
  activePositions,
} = require('../sniper/solana');
const { startDevWatch, stopDevWatch, devWatches } = require('../sniper/devwatch');
const { scoreToken, formatScore } = require('../sniper/scorer');
const { getStats, getRecentTrades, logEntry, saveSetting, loadSettings, saveAllSettings } = require('../db/tradeHistory');

const watchlist = new Set();
let autoSnipeEnabled = false;
let userSettings = { ...CONFIG.DEFAULT_FILTERS };

// ── Load persisted settings from MongoDB on boot ──────────────────
async function initSettings() {
  try {
    const saved = await loadSettings();
    if (Object.keys(saved).length > 0) {
      userSettings = { ...CONFIG.DEFAULT_FILTERS, ...saved };
      console.log('[settings] ✅ Loaded persisted settings from MongoDB');
    } else {
      console.log('[settings] No saved settings — using defaults');
    }
  } catch (err) {
    console.error('[settings] Failed to load:', err.message);
  }
}

function ownerOnly(ctx, next) {
  const userId = String(ctx.from?.id);
  if (userId !== String(CONFIG.OWNER_TELEGRAM_ID)) {
    return ctx.reply('🚫 Access denied. Alien Intelligence is invite-only.');
  }
  return next();
}

function formatNumber(n) {
  if (!n) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function setupCommands(bot) {

  // ── /start ────────────────────────────────────────────────────
  bot.command('start', ownerOnly, async (ctx) => {
    await ctx.replyWithMarkdown(
      `👾 *ALIEN INTELLIGENCE* — Online\n\n` +
      `Multi-chain on-chain sniper. Solana live. Base incoming.\n\n` +
      `*Snipe Commands:*\n` +
      `/snipe <mint> — Execute snipe on token\n` +
      `/analyze <mint> — Full analysis + conviction score\n` +
      `/autoon — Enable auto-snipe + migration listener\n` +
      `/autooff — Disable auto-snipe\n\n` +
      `*Position Commands:*\n` +
      `/pnl — Open positions & live P&L\n` +
      `/history — Trade history + win rate\n` +
      `/watchlist — View / manage watchlist\n\n` +
      `*Safety Commands:*\n` +
      `/devwatch — Dev wallet monitor\n\n` +
      `*Settings:*\n` +
      `/settings — View filter settings\n` +
      `/set <key> <value> — Update a setting\n` +
      `/admin — Admin panel\n\n` +
      `Phase 1 — Solana mainnet active 🟢\n` +
      `Migration listener — WebSocket active ⚡\n\n` +
      `📱 *Dashboard* — tap the menu button below`
    );
  });

  // ── /analyze <mint> ──────────────────────────────────────────
  bot.command('analyze', ownerOnly, async (ctx) => {
    const args = ctx.message.text.split(' ');
    const mint = args[1]?.trim();
    if (!mint) return ctx.reply('Usage: /analyze <mint_address>');

    const msg = await ctx.reply('🔍 Scanning token...');

    try {
      const { pass, reasons, warnings, data } = await runFilters(mint, userSettings);

      if (!data) {
        return ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, null,
          '❌ Could not fetch token data. Check mint address.'
        );
      }

      const scoreResult = await scoreToken(mint, {
        liquidity: data.liquidity,
        holderCount: data.holderCount,
        buyRatio: data.buyRatio,
        tokenAgeSecs: data.tokenAgeSecs,
        buyTax: data.buyTax,
        sellTax: data.sellTax,
        mintAuthorityRevoked: !data.mintAuthority,
        freezeAuthorityRevoked: !data.freezeAuthority,
        topHolderPercent: data.topHolderPercent || 0,
      }, 'safety');

      const verdict = pass ? '✅ PASS — Safe to snipe' : '❌ FAIL — Filters triggered';
      const warnText = warnings.length ? '\n⚠️ *Warnings:*\n' + warnings.join('\n') : '';
      const failText = reasons.length ? '\n🚫 *Failed:*\n' + reasons.join('\n') : '';
      const scoreText = formatScore(scoreResult);

      const text =
        `👾 *Token Analysis*\n\n` +
        `*${data.name} (${data.symbol})*\n` +
        `Price: $${parseFloat(data.price).toFixed(8)}\n` +
        `Liquidity: ${formatNumber(data.liquidity)}\n` +
        `MCap: ${formatNumber(data.marketCap)}\n` +
        `Holders: ${data.holderCount}\n` +
        `Age: ${Math.floor(data.tokenAgeSecs / 60)}m ${data.tokenAgeSecs % 60}s\n` +
        `Buy ratio (1h): ${data.buyRatio}%\n` +
        `Buys/Sells: ${data.buys}/${data.sells}\n` +
        `Buy tax: ${data.buyTax}% | Sell tax: ${data.sellTax}%\n\n` +
        `*Verdict: ${verdict}*` +
        warnText +
        failText +
        scoreText +
        `\n\n[DexScreener](${data.dexUrl})`;

      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null, text,
        {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          ...Markup.inlineKeyboard([
            pass
              ? [Markup.button.callback(`🚀 Snipe ${userSettings.buyAmountSol} SOL`, `snipe_${mint}`)]
              : [],
            [Markup.button.url('📊 Chart', data.dexUrl)],
          ]),
        }
      );
    } catch (err) {
      ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null,
        `❌ Analysis error: ${err.message}`
      );
    }
  });

  // ── /snipe <mint> ────────────────────────────────────────────
  bot.command('snipe', ownerOnly, async (ctx) => {
    const args = ctx.message.text.split(' ');
    const mint = args[1]?.trim();
    if (!mint) return ctx.reply('Usage: /snipe <mint_address>');
    await executeSnipe(ctx, mint);
  });

  bot.action(/^snipe_(.+)$/, ownerOnly, async (ctx) => {
    const mint = ctx.match[1];
    await ctx.answerCbQuery('Executing snipe...');
    await executeSnipe(ctx, mint);
  });

  async function executeSnipe(ctx, mint) {
    const msg = await ctx.reply('🛸 Running filters before snipe...');

    try {
      const { pass, reasons, data } = await runFilters(mint, userSettings);

      if (!pass) {
        return ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, null,
          `❌ *Snipe aborted — filters failed:*\n${reasons.join('\n')}`,
          { parse_mode: 'Markdown' }
        );
      }

      const score = await scoreToken(mint, {
        liquidity: data.liquidity,
        holderCount: data.holderCount,
        buyRatio: data.buyRatio,
        tokenAgeSecs: data.tokenAgeSecs,
        buyTax: data.buyTax,
        sellTax: data.sellTax,
        mintAuthorityRevoked: !data.mintAuthority,
        freezeAuthorityRevoked: !data.freezeAuthority,
        topHolderPercent: data.topHolderPercent || 0,
      }, 'safety');

      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null,
        `✅ Filters passed — Conviction: ${score.score}/100 ${score.emoji}\n` +
        `Sniping ${userSettings.buyAmountSol} SOL → *${data.symbol}*...`,
        { parse_mode: 'Markdown' }
      );

      const entryPrice = parseFloat(data.price);
      const { txid, amountOut } = await executeSwap(mint, userSettings.buyAmountSol);

      activePositions.set(mint, {
        symbol: data.symbol,
        entryPrice,
        tokenAmount: amountOut,
        takeProfitPercent: userSettings.takeProfitPercent,
        stopLossPercent: userSettings.stopLossPercent,
        boughtAt: Date.now(),
        solSpent: userSettings.buyAmountSol,
      });

      await logEntry({
        mint,
        symbol: data.symbol,
        entryPrice,
        solSpent: userSettings.buyAmountSol,
        tokenAmount: amountOut,
        txidEntry: txid,
        convictionScore: score.score,
      });

      await startDevWatch(mint, data.symbol, async (devMsg) => {
        ctx.replyWithMarkdown(devMsg, { disable_web_page_preview: true });
      }, false);

      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null,
        `🟢 *SNIPED* — ${data.symbol}\n\n` +
        `Spent: ${userSettings.buyAmountSol} SOL\n` +
        `Entry: $${entryPrice.toFixed(8)}\n` +
        `Conviction: ${score.score}/100 ${score.emoji}\n` +
        `TP: +${userSettings.takeProfitPercent}% | SL: -${userSettings.stopLossPercent}%\n` +
        `Dev watch: 👁️ Active\n` +
        `TX: \`${txid}\`\n\n` +
        `[View on Solscan](https://solscan.io/tx/${txid})`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    } catch (err) {
      ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null,
        `❌ Snipe failed: ${err.message}`
      );
    }
  }

  // ── /autoon ──────────────────────────────────────────────────
  bot.command('autoon', ownerOnly, (ctx) => {
    autoSnipeEnabled = true;
    ctx.replyWithMarkdown(
      `🤖 *Auto-snipe ON*\n\n` +
      `Monitoring new Solana pairs every 60s.\n` +
      `Migration WebSocket listener active ⚡\n` +
      `Amount per trade: ${userSettings.buyAmountSol} SOL\n\n` +
      `Use /autooff to stop.`
    );
  });

  // ── /autooff ─────────────────────────────────────────────────
  bot.command('autooff', ownerOnly, (ctx) => {
    autoSnipeEnabled = false;
    ctx.replyWithMarkdown(
      '🔴 *Auto-snipe OFF*\nMonitoring paused. Migration alerts still active.'
    );
  });

  // ── /watchlist ───────────────────────────────────────────────
  bot.command('watchlist', ownerOnly, async (ctx) => {
    const args = ctx.message.text.split(' ');
    const sub = args[1]?.trim();
    const mint = args[2]?.trim();

    if (sub === 'add' && mint) {
      watchlist.add(mint);
      return ctx.reply(`✅ Added: \`${mint}\``, { parse_mode: 'Markdown' });
    }
    if (sub === 'remove' && mint) {
      watchlist.delete(mint);
      return ctx.reply(`🗑️ Removed: \`${mint}\``, { parse_mode: 'Markdown' });
    }

    if (watchlist.size === 0) {
      return ctx.reply(
        '📋 Watchlist is empty.\n\n`/watchlist add <mint>`\n`/watchlist remove <mint>`',
        { parse_mode: 'Markdown' }
      );
    }

    const lines = await Promise.all(
      [...watchlist].map(async (m, i) => {
        const price = await getCurrentPrice(m);
        return `${i + 1}. \`${m.slice(0, 8)}...\` — $${price?.toFixed(8) || 'N/A'}`;
      })
    );

    ctx.replyWithMarkdown(
      `📋 *Watchlist (${watchlist.size})*\n\n` +
      lines.join('\n') +
      '\n\n`/watchlist add <mint>` | `/watchlist remove <mint>`'
    );
  });

  // ── /pnl ─────────────────────────────────────────────────────
  bot.command('pnl', ownerOnly, async (ctx) => {
    if (activePositions.size === 0) {
      return ctx.reply('📊 No open positions.');
    }

    const lines = await Promise.all(
      [...activePositions.entries()].map(async ([mint, pos]) => {
        const currentPrice = await getCurrentPrice(mint);
        const change = currentPrice && pos.entryPrice
          ? ((currentPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(1)
          : 'N/A';
        const sign = parseFloat(change) >= 0 ? '+' : '';
        const emoji = parseFloat(change) >= 0 ? '🟢' : '🔴';
        const devWatching = devWatches.has(mint) ? ' 👁️' : '';
        return (
          `${emoji} *${pos.symbol}*${devWatching}\n` +
          `  Entry: $${pos.entryPrice?.toFixed(8) || '?'}\n` +
          `  Now: $${currentPrice?.toFixed(8) || '?'}\n` +
          `  PnL: ${sign}${change}%\n` +
          `  TP: +${pos.takeProfitPercent}% | SL: -${pos.stopLossPercent}%`
        );
      })
    );

    ctx.replyWithMarkdown(
      `📊 *Open Positions (${activePositions.size})*\n\n` +
      lines.join('\n\n')
    );
  });

  // ── /history ─────────────────────────────────────────────────
  bot.command('history', ownerOnly, async (ctx) => {
    const stats = await getStats();

    if (!stats || stats.trades === 0) {
      return ctx.reply(
        `📈 *Trade History*\n\nNo closed trades yet.\nOpen positions: ${stats?.open || 0}`,
        { parse_mode: 'Markdown' }
      );
    }

    const recent = await getRecentTrades(5);
    const recentLines = recent.map(t => {
      const sign = t.pnlPercent >= 0 ? '+' : '';
      const emoji = t.pnlPercent >= 0 ? '🟢' : '🔴';
      return `${emoji} *${t.symbol}* ${sign}${t.pnlPercent?.toFixed(1)}% (${sign}${t.pnlSol?.toFixed(3)} SOL)`;
    });

    ctx.replyWithMarkdown(
      `📈 *Trade History*\n\n` +
      `Total trades: ${stats.trades}\n` +
      `Open: ${stats.open}\n` +
      `Win rate: ${stats.winRate}%\n` +
      `Wins: ${stats.wins} | Losses: ${stats.losses}\n` +
      `Avg PnL: ${stats.avgPnl}%\n` +
      `Total PnL: ${stats.totalPnlSol} SOL\n\n` +
      `🏆 Best: *${stats.bestTrade.symbol}* +${stats.bestTrade.pnl}%\n` +
      `💀 Worst: *${stats.worstTrade.symbol}* ${stats.worstTrade.pnl}%\n\n` +
      `*Last 5 trades:*\n` +
      recentLines.join('\n')
    );
  });

  // ── /devwatch ────────────────────────────────────────────────
  bot.command('devwatch', ownerOnly, async (ctx) => {
    const args = ctx.message.text.split(' ');
    const sub = args[1]?.trim();
    const mint = args[2]?.trim();
    const autoSell = args[3]?.trim() === 'autosell';

    if (sub === 'start' && mint) {
      const pos = activePositions.get(mint);
      const symbol = pos?.symbol || 'Unknown';
      await startDevWatch(
        mint, symbol,
        (msg) => ctx.replyWithMarkdown(msg, { disable_web_page_preview: true }),
        autoSell
      );
      return;
    }

    if (sub === 'stop' && mint) {
      stopDevWatch(mint);
      return ctx.reply(
        `🛑 Dev watch stopped for \`${mint.slice(0, 8)}...\``,
        { parse_mode: 'Markdown' }
      );
    }

    if (devWatches.size === 0) {
      return ctx.reply(
        `👁️ No active dev watches.\n\n` +
        `/devwatch start <mint> — watch dev wallet\n` +
        `/devwatch start <mint> autosell — auto-sell on move\n` +
        `/devwatch stop <mint> — stop watching`,
        { parse_mode: 'Markdown' }
      );
    }

    const lines = [...devWatches.entries()].map(([m, w]) =>
      `• *${w.symbol}* — \`${w.devWallet.slice(0, 8)}...${w.devWallet.slice(-6)}\`\n` +
      `  Balance: ${w.lastBalance?.toLocaleString()} | Auto-sell: ${w.autoSell ? '✅' : '❌'}`
    );

    ctx.replyWithMarkdown(
      `👁️ *Active Dev Watches (${devWatches.size})*\n\n` +
      lines.join('\n\n')
    );
  });

  // ── /settings ────────────────────────────────────────────────
  bot.command('settings', ownerOnly, (ctx) => {
    const s = userSettings;
    ctx.replyWithMarkdown(
      `⚙️ *Filter Settings*\n\n` +
      `Min Liquidity: $${s.minLiquidity.toLocaleString()}\n` +
      `LP Locked: ${s.lpLocked}\n` +
      `Max Dev %: ${s.maxDevPercent}%\n` +
      `Max Top Holder %: ${s.maxTopHolderPercent}%\n` +
      `Min Holders: ${s.minHolderCount}\n` +
      `Min Token Age: ${s.minTokenAgeSecs}s\n` +
      `Min Buy Ratio: ${s.minBuyRatio}%\n` +
      `Max Buy Tax: ${s.maxBuyTax}%\n` +
      `Max Sell Tax: ${s.maxSellTax}%\n` +
      `Mint Auth Revoked: ${s.mintAuthorityRevoked}\n` +
      `Freeze Auth Revoked: ${s.freezeAuthorityRevoked}\n\n` +
      `*Trade Settings*\n` +
      `Buy Amount: ${s.buyAmountSol} SOL\n` +
      `Take Profit: +${s.takeProfitPercent}%\n` +
      `Stop Loss: -${s.stopLossPercent}%\n\n` +
      `To change:\n` +
      `\`/set minLiquidity 50000\`\n` +
      `\`/set buyAmountSol 0.3\`\n` +
      `\`/set takeProfitPercent 150\``
    );
  });

  // ── /set <key> <value> ───────────────────────────────────────
  bot.command('set', ownerOnly, async (ctx) => {
    const parts = ctx.message.text.split(' ');
    const key = parts[1]?.trim();
    const value = parts[2]?.trim();

    if (!key || value === undefined) {
      return ctx.reply('Usage: /set <key> <value>\nExample: /set buyAmountSol 0.5');
    }

    const numericKeys = [
      'minLiquidity', 'maxDevPercent', 'maxTopHolderPercent', 'minHolderCount',
      'minTokenAgeSecs', 'minBuyRatio', 'maxBuyTax', 'maxSellTax',
      'buyAmountSol', 'takeProfitPercent', 'stopLossPercent',
    ];
    const boolKeys = ['lpLocked', 'mintAuthorityRevoked', 'freezeAuthorityRevoked'];

    if (numericKeys.includes(key)) {
      const num = parseFloat(value);
      if (isNaN(num)) return ctx.reply(`❌ "${value}" is not a valid number`);
      userSettings[key] = num;
      await saveSetting(key, num);
      return ctx.reply(`✅ ${key} set to ${num} (saved)`);
    }

    if (boolKeys.includes(key)) {
      const bool = value === 'true';
      userSettings[key] = bool;
      await saveSetting(key, bool);
      return ctx.reply(`✅ ${key} set to ${bool} (saved)`);
    }

    ctx.reply(`❌ Unknown setting key: ${key}`);
  });

  // ── /admin ───────────────────────────────────────────────────
  bot.command('admin', ownerOnly, (ctx) => {
    ctx.replyWithMarkdown(
      `🛸 *Admin Panel — Phase 1*\n\n` +
      `Auto-snipe: ${autoSnipeEnabled ? '🟢 ON' : '🔴 OFF'}\n` +
      `Watchlist: ${watchlist.size} tokens\n` +
      `Open positions: ${activePositions.size}\n` +
      `Dev watches: ${devWatches.size}\n` +
      `Migration listener: ⚡ WebSocket active\n\n` +
      `*Roadmap*\n` +
      `Phase 2: Subscriptions + Access Control\n` +
      `Phase 3: Solana Pay payments\n` +
      `Phase 4: Base chain + whale tracker\n` +
      `Phase 5: Public launch`
    );
  });

  // ── Web App Data Handler ─────────────────────────────────────
  bot.on('web_app_data', ownerOnly, async (ctx) => {
    let data;
    try {
      data = JSON.parse(ctx.webAppData.data.text());
    } catch {
      return ctx.reply('❌ Invalid data from Mini App');
    }

    const cmd = data.cmd;

    if (cmd === 'autoon') {
      autoSnipeEnabled = true;
      return ctx.replyWithMarkdown(
        `🤖 *Auto-snipe ON* via Dashboard\n\n` +
        `Monitoring new pairs every 60s.\n` +
        `Migration WebSocket active ⚡`
      );
    }

    if (cmd === 'autooff') {
      autoSnipeEnabled = false;
      return ctx.replyWithMarkdown('🔴 *Auto-snipe OFF* via Dashboard');
    }

    if (cmd === 'snipe' && data.mint) {
      await ctx.replyWithMarkdown(
        `🛸 *Snipe initiated from Dashboard*\n\n` +
        `Token: *${data.symbol || data.mint.slice(0, 8)}*\n` +
        `Running filters...`
      );
      await executeSnipe(ctx, data.mint);
      return;
    }

    if (cmd === 'settings_update') {
      const updates = [];
      const numericKeys = [
        'minLiquidity', 'minBuyRatio', 'maxTopHolderPercent',
        'minTokenAgeSecs', 'buyAmountSol', 'takeProfitPercent', 'stopLossPercent',
      ];

      for (const key of numericKeys) {
        if (data[key] !== undefined) {
          userSettings[key] = data[key];
          updates.push(`${key} → ${data[key]}`);
        }
      }

      // Save all to MongoDB
      await saveAllSettings(userSettings);

      return ctx.replyWithMarkdown(
        `⚙️ *Settings updated via Dashboard*\n\n` +
        updates.map(u => `✅ ${u}`).join('\n')
      );
    }

    ctx.reply('❓ Unknown Mini App command: ' + cmd);
  });

  // ── Catch unknown ─────────────────────────────────────────────
  bot.on('text', ownerOnly, (ctx) => {
    ctx.reply('❓ Unknown command. Try /start for the full command list.');
  });

  return {
    getAutoSnipeEnabled: () => autoSnipeEnabled,
    getWatchlist: () => watchlist,
    initSettings,
    getUserSettings: () => userSettings,
  };
}

module.exports = { setupCommands };
