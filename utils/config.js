require('dotenv').config();

const OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID;

const DEFAULT_FILTERS = {
  minLiquidity: 80000,
  lpLocked: true,
  maxDevPercent: 5,
  maxTopHolderPercent: 10,
  minHolderCount: 100,
  minTokenAgeSecs: 300,
  minBuyRatio: 65,
  maxBuyTax: 5,
  maxSellTax: 5,
  mintAuthorityRevoked: true,
  freezeAuthorityRevoked: true,
  buyAmountSol: 0.5,
  takeProfitPercent: 100,
  stopLossPercent: 30,
};

const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  HELIUS_RPC: process.env.HELIUS_RPC || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  HELIUS_API_KEY: process.env.HELIUS_API_KEY,
  OWNER_WALLET: process.env.OWNER_WALLET,
  OWNER_PRIVATE_KEY: process.env.OWNER_PRIVATE_KEY,
  OWNER_TELEGRAM_ID,
  MONGODB_URI: process.env.MONGODB_URI,
  DEFAULT_FILTERS,
  PHASE: 1,
};

module.exports = CONFIG;
