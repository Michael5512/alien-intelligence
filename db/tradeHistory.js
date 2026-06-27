const mongoose = require('mongoose');

const tradeSchema = new mongoose.Schema({
  mint: { type: String, required: true },
  symbol: { type: String, required: true },
  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number, default: null },
  solSpent: { type: Number, required: true },
  solReturned: { type: Number, default: null },
  tokenAmount: { type: Number, required: true },
  pnlPercent: { type: Number, default: null },
  pnlSol: { type: Number, default: null },
  exitReason: {
    type: String,
    enum: ['take_profit', 'stop_loss', 'dev_move', 'manual', 'open'],
    default: 'open',
  },
  convictionScore: { type: Number, default: null },
  openedAt: { type: Date, default: Date.now },
  closedAt: { type: Date, default: null },
  txidEntry: { type: String, default: null },
  txidExit: { type: String, default: null },
});

const Trade = mongoose.model('Trade', tradeSchema);

async function logEntry({ mint, symbol, entryPrice, solSpent, tokenAmount, txidEntry, convictionScore }) {
  try {
    await Trade.create({
      mint, symbol, entryPrice, solSpent,
      tokenAmount, txidEntry, convictionScore,
      exitReason: 'open',
    });
  } catch (err) {
    console.error('[tradeHistory] logEntry error:', err.message);
  }
}

async function logExit({ mint, exitPrice, solReturned, exitReason, txidExit }) {
  try {
    const trade = await Trade.findOne({ mint, exitReason: 'open' }).sort({ openedAt: -1 });
    if (!trade) return;
    const pnlSol = solReturned - trade.solSpent;
    const pnlPercent = ((solReturned - trade.solSpent) / trade.solSpent) * 100;
    trade.exitPrice = exitPrice;
    trade.solReturned = solReturned;
    trade.exitReason = exitReason;
    trade.txidExit = txidExit;
    trade.pnlSol = pnlSol;
    trade.pnlPercent = pnlPercent;
    trade.closedAt = new Date();
    await trade.save();
  } catch (err) {
    console.error('[tradeHistory] logExit error:', err.message);
  }
}

async function getStats() {
  try {
    const closed = await Trade.find({ exitReason: { $ne: 'open' } });
    const open = await Trade.find({ exitReason: 'open' });
    if (!closed.length) return { trades: 0, open: open.length };
    const wins = closed.filter(t => t.pnlPercent > 0);
    const losses = closed.filter(t => t.pnlPercent <= 0);
    const winRate = ((wins.length / closed.length) * 100).toFixed(1);
    const avgPnl = (closed.reduce((s, t) => s + (t.pnlPercent || 0), 0) / closed.length).toFixed(1);
    const totalPnlSol = closed.reduce((s, t) => s + (t.pnlSol || 0), 0).toFixed(3);
    const bestTrade = closed.reduce((b, t) => (t.pnlPercent || 0) > (b.pnlPercent || 0) ? t : b, closed[0]);
    const worstTrade = closed.reduce((w, t) => (t.pnlPercent || 0) < (w.pnlPercent || 0) ? t : w, closed[0]);
    return {
      trades: closed.length, open: open.length,
      wins: wins.length, losses: losses.length,
      winRate, avgPnl, totalPnlSol,
      bestTrade: { symbol: bestTrade.symbol, pnl: bestTrade.pnlPercent?.toFixed(1) },
      worstTrade: { symbol: worstTrade.symbol, pnl: worstTrade.pnlPercent?.toFixed(1) },
    };
  } catch (err) {
    console.error('[tradeHistory] getStats error:', err.message);
    return null;
  }
}

async function getRecentTrades(limit = 5) {
  try {
    return await Trade.find({ exitReason: { $ne: 'open' } })
      .sort({ closedAt: -1 })
      .limit(limit);
  } catch (err) {
    console.error('[tradeHistory] getRecentTrades error:', err.message);
    return [];
  }
}

module.exports = { logEntry, logExit, getStats, getRecentTrades, Trade };
