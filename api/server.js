const express = require('express');
const router = express.Router();
const { activePositions } = require('../sniper/solana');
const { devWatches } = require('../sniper/devwatch');
const { getCurrentPrice } = require('../sniper/solana');
const { getStats, getRecentTrades } = require('../db/tradeHistory');

// ── CORS middleware ───────────────────────────────────────────────
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ── GET /api/positions ────────────────────────────────────────────
router.get('/positions', async (req, res) => {
  try {
    const positions = [];

    for (const [mint, pos] of activePositions) {
      const currentPrice = await getCurrentPrice(mint);
      const change = currentPrice && pos.entryPrice
        ? ((currentPrice - pos.entryPrice) / pos.entryPrice * 100)
        : null;

      const devWatch = devWatches.get(mint);

      positions.push({
        mint,
        symbol: pos.symbol,
        entryPrice: pos.entryPrice,
        currentPrice,
        pnlPercent: change ? parseFloat(change.toFixed(2)) : null,
        solSpent: pos.solSpent,
        takeProfitPercent: pos.takeProfitPercent,
        stopLossPercent: pos.stopLossPercent,
        boughtAt: pos.boughtAt,
        devWatch: devWatch ? {
          active: true,
          devWallet: devWatch.devWallet,
          initialBalance: devWatch.initialBalance,
          lastBalance: devWatch.lastBalance,
          autoSell: devWatch.autoSell,
          dropPercent: devWatch.initialBalance > 0
            ? parseFloat(((devWatch.initialBalance - devWatch.lastBalance) / devWatch.initialBalance * 100).toFixed(1))
            : 0,
        } : { active: false },
      });
    }

    res.json({ success: true, count: positions.length, positions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/history ─────────────────────────────────────────────
router.get('/history', async (req, res) => {
  try {
    const recent = await getRecentTrades(10);
    const stats = await getStats();

    res.json({
      success: true,
      stats,
      trades: recent.map(t => ({
        symbol: t.symbol,
        pnlPercent: t.pnlPercent,
        pnlSol: t.pnlSol,
        exitReason: t.exitReason,
        convictionScore: t.convictionScore,
        closedAt: t.closedAt,
        txidEntry: t.txidEntry,
        txidExit: t.txidExit,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/stats ────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json({
      success: true,
      openPositions: activePositions.size,
      devWatches: devWatches.size,
      autoSnipeEnabled: global.autoSnipeEnabled || false,
      ...stats,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/spots ────────────────────────────────────────────────
// Tracks early bird spots — stored in MongoDB via a simple counter
router.get('/spots', async (req, res) => {
  try {
    const mongoose = require('mongoose');

    // Simple spots counter schema
    let SpotsModel;
    try {
      SpotsModel = mongoose.model('Spots');
    } catch {
      const spotsSchema = new mongoose.Schema({
        tier: String,
        claimed: { type: Number, default: 0 },
        total: { type: Number, default: 50 },
      });
      SpotsModel = mongoose.model('Spots', spotsSchema);
    }

    let spots = await SpotsModel.findOne({ tier: 'earlybird' });
    if (!spots) {
      spots = await SpotsModel.create({ tier: 'earlybird', claimed: 0, total: 50 });
    }

    res.json({
      success: true,
      claimed: spots.claimed,
      total: spots.total,
      remaining: spots.total - spots.claimed,
      percentFilled: Math.round((spots.claimed / spots.total) * 100),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/health ───────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'online',
    phase: 1,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
