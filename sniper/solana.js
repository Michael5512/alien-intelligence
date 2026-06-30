const {
  Connection,
  Keypair,
  VersionedTransaction,
} = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');
const CONFIG = require('../utils/config');

const connection = new Connection(CONFIG.HELIUS_RPC, 'confirmed');

function getKeypair() {
  if (!CONFIG.OWNER_PRIVATE_KEY) throw new Error('OWNER_PRIVATE_KEY not set');
  const decoded = bs58.decode(CONFIG.OWNER_PRIVATE_KEY);
  return Keypair.fromSecretKey(decoded);
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_BASE = 'https://api.jup.ag/swap/v1';

const activePositions = new Map();

async function getQuote(outputMint, amountSol) {
  const amountLamports = Math.floor(amountSol * 1e9);
  const url = `${JUP_BASE}/quote?inputMint=${SOL_MINT}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=500`;
  const res = await axios.get(url, { timeout: 10000 });
  return res.data;
}

async function executeSwap(outputMint, amountSol) {
  const keypair = getKeypair();

  const quote = await getQuote(outputMint, amountSol);
  if (!quote || !quote.outAmount) throw new Error('No quote returned from Jupiter');

  const swapRes = await axios.post(`${JUP_BASE}/swap`, {
    quoteResponse: quote,
    userPublicKey: keypair.publicKey.toString(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto',
  }, { timeout: 15000 });

  const { swapTransaction } = swapRes.data;
  if (!swapTransaction) throw new Error('No swapTransaction in Jupiter response');

  const txBuf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction(txid, 'confirmed');

  return { txid, amountOut: quote.outAmount, inAmount: Math.floor(amountSol * 1e9) };
}

async function sellToken(mintAddress, tokenAmount) {
  const keypair = getKeypair();

  const url = `${JUP_BASE}/quote?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${tokenAmount}&slippageBps=800`;
  const quote = (await axios.get(url, { timeout: 10000 })).data;
  if (!quote || !quote.outAmount) throw new Error('No sell quote from Jupiter');

  const swapRes = await axios.post(`${JUP_BASE}/swap`, {
    quoteResponse: quote,
    userPublicKey: keypair.publicKey.toString(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto',
  }, { timeout: 15000 });

  const txBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(txid, 'confirmed');
  return { txid, amountOut: quote.outAmount };
}

async function getCurrentPrice(mintAddress) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
      { timeout: 6000 }
    );
    const pairs = res.data?.pairs?.filter(p => p.chainId === 'solana') || [];
    if (!pairs.length) return null;
    return parseFloat(pairs[0].priceUsd || '0');
  } catch {
    return null;
  }
}

async function monitorPosition(mintAddress, notifyFn) {
  const pos = activePositions.get(mintAddress);
  if (!pos) return;

  const currentPrice = await getCurrentPrice(mintAddress);
  if (!currentPrice || !pos.entryPrice) return;

  const changePct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

  if (changePct >= pos.takeProfitPercent) {
    try {
      const { txid } = await sellToken(mintAddress, pos.tokenAmount);
      activePositions.delete(mintAddress);
      notifyFn(
        `🟢 *TAKE PROFIT HIT* — ${pos.symbol}\n` +
        `+${changePct.toFixed(1)}% | Entry: $${pos.entryPrice.toFixed(8)} → Now: $${currentPrice.toFixed(8)}\n` +
        `✅ Sold | TX: \`${txid}\``,
        { reason: 'take_profit', exitPrice: currentPrice, solReturned: pos.solSpent * (1 + changePct / 100), txid }
      );
    } catch (err) {
      notifyFn(`⚠️ TP sell failed for ${pos.symbol}: ${err.message}`);
    }
    return;
  }

  if (changePct <= -pos.stopLossPercent) {
    try {
      const { txid } = await sellToken(mintAddress, pos.tokenAmount);
      activePositions.delete(mintAddress);
      notifyFn(
        `🔴 *STOP LOSS HIT* — ${pos.symbol}\n` +
        `${changePct.toFixed(1)}% | Entry: $${pos.entryPrice.toFixed(8)} → Now: $${currentPrice.toFixed(8)}\n` +
        `✅ Sold | TX: \`${txid}\``,
        { reason: 'stop_loss', exitPrice: currentPrice, solReturned: pos.solSpent * (1 + changePct / 100), txid }
      );
    } catch (err) {
      notifyFn(`⚠️ SL sell failed for ${pos.symbol}: ${err.message}`);
    }
  }
}

module.exports = {
  executeSwap,
  sellToken,
  getCurrentPrice,
  monitorPosition,
  activePositions,
  connection,
};
