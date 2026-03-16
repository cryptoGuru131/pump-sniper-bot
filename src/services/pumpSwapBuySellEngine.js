/**
 * PumpSwap buy/sell engine for migrated tokens.
 * Uses @pump-fun/pump-swap-sdk for AMM swaps.
 * No priority fee.
 * @module services/pumpSwapBuySellEngine
 */

import BN from "bn.js";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { AccountLayout } from "@solana/spl-token";
import * as pumpSdk from "@pump-fun/pump-sdk";
import * as pumpSwapSdk from "@pump-fun/pump-swap-sdk";

import { config, getKeypair } from "../config/index.js";
import { hasPosition, setPositionOpen, setPositionClosed } from "./positionLock.js";

const DEDUPE_MS = 5000;
const CONFIRM_POLL_MS = 100;

let connection = null;
let wallet = null;
const recentMints = new Set();
let lastDedupeClean = Date.now();

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanDedupe() {
  const now = Date.now();
  if (now - lastDedupeClean > DEDUPE_MS) {
    recentMints.clear();
    lastDedupeClean = now;
  }
}

export async function initPumpSwapTrader() {
  const kp = await getKeypair();
  if (!kp) return false;
  wallet = kp;

  connection = new Connection(config.rpc.url, {
    commitment: config.rpc.commitment,
    confirmTransactionInitialTimeout: 15_000,
  });

  const delayMin = config.trading.autoSellDelayMs / 60_000;
  console.log(
    "✅ PumpSwap trader ready",
    config.trading.autoSellEnabled ? `| auto-sell ${delayMin}min` : ""
  );
  return true;
}

/**
 * Execute buy on PumpSwap (migrated tokens).
 * Uses buyQuoteInput: spend SOL, get tokens.
 * @param {{ mint: string }} migratedInfo - from migration detector
 * @returns {Promise<boolean|null>}
 */
export async function executeBuyPumpSwap(migratedInfo) {
  if (!config.trading.enabled || !wallet || !connection) return null;
  if (hasPosition()) {
    return null; // skip: waiting for sell before next buy
  }

  const mintAddress = migratedInfo.mint;

  cleanDedupe();
  if (recentMints.has(mintAddress)) return null;
  recentMints.add(mintAddress);

  const mint = new PublicKey(mintAddress);
  const user = wallet.publicKey;

  const poolKey = pumpSwapSdk.canonicalPumpPoolPda(mint);
  const pumpAmmSdk = new pumpSwapSdk.OnlinePumpAmmSdk(connection);

  let swapSolanaState;
  try {
    swapSolanaState = await pumpAmmSdk.swapSolanaState(poolKey, user);
  } catch (e) {
    console.error(`❌ PumpSwap buy failed (${mintAddress}): pool not ready:`, e?.message ?? e);
    return null;
  }

  const quoteLamports = Number(config.trading.buyMaxSolLamports.toString());
  const slippage = config.trading.slippageBps / 100;

  let instructions;
  try {
    instructions = await pumpSwapSdk.PUMP_AMM_SDK.buyQuoteInput(
      swapSolanaState,
      new BN(quoteLamports),
      slippage
    );
  } catch (e) {
    console.error(`❌ PumpSwap buy failed (${mintAddress}):`, e?.message ?? e);
    return null;
  }

  const tx = new Transaction().add(...instructions);
  let blockhash = migratedInfo.blockhash;
  if (!blockhash) {
    const latest = await connection.getLatestBlockhash(config.rpc.commitment);
    blockhash = latest.blockhash;
  }
  tx.recentBlockhash = blockhash;
  tx.feePayer = user;

  let sig;
  try {
    sig = await connection.sendTransaction(tx, [wallet], {
      skipPreflight: true,
      preflightCommitment: config.rpc.commitment,
      maxRetries: 3,
    });
  } catch (e) {
    console.error(`❌ PumpSwap buy tx failed (${mintAddress}):`, e?.message ?? e);
    return null;
  }

  let success = false;
  for (let i = 0; i < 120; i++) {
    await sleep(CONFIRM_POLL_MS);
    const status = await connection.getSignatureStatus(sig);
    if (status?.value) {
      success = status.value.err == null;
      break;
    }
  }

  if (success) {
    if (config.trading.autoSellEnabled) setPositionOpen();
    console.log(`🟢 PUMPSWAP BUY SENT ${mintAddress} | ${sig}`);
    if (config.trading.autoSellEnabled) {
      const delayMs = config.trading.autoSellDelayMs;
      setTimeout(
        () =>
          executeSellPumpSwap(mintAddress).catch((e) => {
            console.error(`❌ PumpSwap auto-sell failed (${mintAddress}):`, e?.message ?? e);
            setPositionClosed();
          }),
        delayMs
      );
    }
  } else {
    console.error(`❌ PumpSwap buy failed (${mintAddress}): ${sig}`);
  }
  return success;
}

/**
 * Execute sell on PumpSwap (migrated tokens).
 * Sells all tokens in user's ATA.
 * @param {string} mintAddress
 */
async function executeSellPumpSwap(mintAddress) {
  if (!wallet || !connection) return;

  const mint = new PublicKey(mintAddress);
  const user = wallet.publicKey;
  const poolKey = pumpSdk.canonicalPumpPoolPda(mint);
  const pumpAmmSdk = new pumpSwapSdk.OnlinePumpAmmSdk(connection);

  let swapSolanaState;
  try {
    swapSolanaState = await pumpAmmSdk.swapSolanaState(poolKey, user);
  } catch (e) {
    console.error(`❌ PumpSwap sell failed (${mintAddress}): pool:`, e?.message ?? e);
    return;
  }

  const { userBaseAccountInfo } = swapSolanaState;
  if (!userBaseAccountInfo?.data) {
    console.warn(`⚠️ PumpSwap sell (${mintAddress}): no token account, skipping`);
    return;
  }

  const decoded = AccountLayout.decode(userBaseAccountInfo.data);
  const amount = new BN(decoded.amount.toString());
  if (amount.isZero()) {
    console.warn(`⚠️ PumpSwap sell (${mintAddress}): zero balance, skipping`);
    return;
  }

  const slippage = config.trading.slippageBps / 100;
  let instructions;
  try {
    instructions = await pumpSwapSdk.PUMP_AMM_SDK.sellBaseInput(
      swapSolanaState,
      amount,
      slippage
    );
  } catch (e) {
    console.error(`❌ PumpSwap sell failed (${mintAddress}):`, e?.message ?? e);
    return;
  }

  const tx = new Transaction().add(...instructions);
  const { blockhash } = await connection.getLatestBlockhash(config.rpc.commitment);
  tx.recentBlockhash = blockhash;
  tx.feePayer = user;

  const sig = await connection.sendTransaction(tx, [wallet], {
    skipPreflight: true,
    preflightCommitment: config.rpc.commitment,
    maxRetries: 3,
  });
  console.log(`🟢 PUMPSWAP SELL SENT ${mintAddress} | ${sig}`);
  setPositionClosed();
}
