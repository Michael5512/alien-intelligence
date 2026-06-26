const { Telegraf, Markup } = require('telegraf');
const CONFIG = require('../utils/config');
const { runFilters } = require('../sniper/filters');
const {
  executeSwap,
  sellToken,
  getCurrentPrice,
  activePositions,
} = require('../sniper/solana');

const watchlist = new Set();
let autoSnipeEnabled = false;
let userSettings = { ...CONFIG.DEFAULT_FILTERS };

function ownerOnly(ctx, next) {
  const userId = String(ctx.from?.id);
  if (userId !== String(CONFIG.OWNER_TELEGRAM_ID)) {
    return ctx.reply('🚫 Access denied. Alien Intelligence is invite-only.');
  }
  return next();
}

function formatNumber(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function setupCommands(bot) {
  bot.command('start', ownerOnly, async (ctx) => {
    await ctx.replyWithMarkdown(
      `👾 *ALIEN INTELLIGENCE* — Online\n\n` +
      `Multi-chain on-chain sniper. Solana live. Base incoming.\n\n` +
      `*Commands:*\n` +
      `/snipe <mint> — Execute snipe on token\n` +
      `/analyze <mint> — Analyze token (no buy)\n` +
      `/autoon — Enable auto-snipe mode\n` +
      `/autooff — Disable auto-snipe mode\n` +
      `/watchlist — View / manage watchlist\n` +
      `/pnl — Open positions & P&L\n` +
      `/settings — View / edit filter settings\n` +
      `/admin — Owner admin panel\n\n` +
      `Phase 1 — Solana mainnet active 🟢`
    );
  });

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

      const verdict = pass ? '✅ PASS — Safe to snipe' : '❌ FAIL — Filters triggered';
      const warnText = warnings.length ? '\n⚠️ *Warnings:*\n' + warnings.join('\n') : '';
      const failText = reasons.length ? '\n🚫 *Failed filters:*\n' + reasons.join('\n') : '';

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

      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null,
        `✅ Filters passed. Sniping ${userSettings.buyAmountSol} SOL → *${data.symbol}*...`,
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

      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null,
        `🟢 *SNIPED* — ${data.symbol}\n\n` +
        `Spent: ${userSettings.buyAmountSol} SOL\n` +
        `Entry: $${entryPrice.toFixed(8)}\n` +
        `TP: +${userSettings.takeProfitPercent}% | SL: -${userSettings.stopLossPercent}%\n` +
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

  bot.command('autoon', ownerOnly, (ctx) => {
    autoSnipeEnabled = true;
    ctx.replyWithMarkdown(
      `🤖 *Auto-snipe ON*\n\nBot will monitor new Solana pairs and auto-snipe when filters pass.\nAmount: ${userSettings.buyAmountSol} SOL per trade.\n\nUse /autooff to stop.`
    );
  });

  bot.command('autooff', ownerOnly, (ctx) => {
    autoSnipeEnabled = false;
    ctx.replyWithMarkdown('🔴 *Auto-snipe OFF*\nMonitoring paused.');
  });

  bot.command('watchlist', ownerOnly, async (ctx) => {
    const args = ctx.message.text.split(' ');
    const sub = args[1]?.trim();
    const mint = args[2]?.trim();

    if (sub === 'add' && mint) {
      watchlist.add(mint);
      return ctx.reply(`✅ Added to watchlist: \`${mint}\``, { parse_mode: 'Markdown' });
    }
    if (sub === 'remove' && mint) {
      watchlist.delete(mint);
      return ctx.reply(`🗑️ Removed from watchlist: \`${mint}\``, { parse_mode: 'Markdown' });
    }

    if (watchlist.size === 0) {
      return ctx.reply('📋 Watchlist is empty.\n\nAdd tokens:\n`/watchlist add <mint>`', { parse_mode: 'Markdown' });
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

  bot.command('pnl', ownerOnly, async (ctx) => {
    if (activePositions.size === 0) return ctx.reply('📊 No open positions.');

    const lines = await Promise.all(
      [...activePositions.entries()].map(async ([mint, pos]) => {
        const currentPrice = await getCurrentPrice(mint);
        const change = currentPrice && pos.entryPrice
          ? ((currentPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(1)
          : 'N/A';
        const sign = parseFloat(change) >= 0 ? '+' : '';
        const emoji = parseFloat(change) >= 0 ? '🟢' : '🔴';
        return (
          `${emoji} *${pos.symbol}*\n` +
          `  Entry: $${pos.entryPrice?.toFixed(8) || '?'}\n` +
          `  Now: $${currentPrice?.toFixed(8) || '?'}\n` +
          `  PnL: ${sign}${change}%\n` +
          `  TP: +${pos.takeProfitPercent}% | SL: -${pos.stopLossPercent}%`
        );
      })
    );

    ctx.replyWithMarkdown(`📊 *Open Positions (${activePositions.size})*\n\n` + lines.join('\n\n'));
  });

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
      `To change:\n\`/set minLiquidity 50000\`\n\`/set buyAmountSol 0.3\`\n\`/set takeProfitPercent 150\``
    );
  });

  bot.command('set', ownerOnly, (ctx) => {
    const parts = ctx.message.text.split(' ');
    const key = parts[1]?.trim();
    const value = parts[2]?.trim();

    if (!key || value === undefined)
      return ctx.reply('Usage: /set <key> <value>\nExample: /set buyAmountSol 0.5');

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
      return ctx.reply(`✅ ${key} set to ${num}`);
    }
    if (boolKeys.includes(key)) {
      userSettings[key] = value === 'true';
      return ctx.reply(`✅ ${key} set to ${value === 'true'}`);
    }
    ctx.reply(`❌ Unknown setting key: ${key}`);
  });

  bot.command('admin', ownerOnly, (ctx) => {
    ctx.replyWithMarkdown(
      `🛸 *Admin Panel — Phase 1*\n\n` +
      `Auto-snipe: ${autoSnipeEnabled ? '🟢 ON' : '🔴 OFF'}\n` +
      `Watchlist: ${watchlist.size} tokens\n` +
      `Open positions: ${activePositions.size}\n\n` +
      `*Roadmap*\n` +
      `Phase 2: Subscriptions + Access Control\n` +
      `Phase 3: Solana Pay payments\n` +
      `Phase 4: Multi-chain + whale tracker\n` +
      `Phase 5: Public launch`
    );
  });

  bot.on('text', ownerOnly, (ctx) => {
    ctx.reply('❓ Unknown command. Try /start for the full command list.');
  });

  return { getAutoSnipeEnabled: () => autoSnipeEnabled, getWatchlist: () => watchlist };
}

module.exports = { setupCommands };
