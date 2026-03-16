/**
 * Pump.fun bonding curve buy/sell engine.
 * Uses @pump-fun/pump-sdk.
 * @module services/pumpFunBuySellEngine
 */

import BN from "bn.js";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as pumpSdk from "@pump-fun/pump-sdk";
const { bondingCurvePda } = pumpSdk;
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { config, getKeypair, TOKEN_2022_PROGRAM_ID } from "../config/index.js";
import { hasPosition, setPositionOpen, setPositionClosed } from "./positionLock.js";

const DEDUPE_MS = 5000;
const CONFIRM_POLL_MS = 100;

let connection = null;
let global = null;
let wallet = null;
let onlineSdk = null;
const recentMints = new Set();
let lastDedupeClean = Date.now();

function getFeeRecipient(globalState) {
  const feeRecipients = [globalState.feeRecipient, ...(globalState.feeRecipients || [])];
  return feeRecipients[Math.floor(Math.random() * feeRecipients.length)];
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Execute sell for tokens bought.
 * @param {{ mintAddress: string, amount: BN, skipPositionClosed?: boolean }}
 */
async function executeSell({ mintAddress, amount, skipPositionClosed = false }) {
  if (!wallet || !global || !connection || !onlineSdk) return;

  const tokenProgram = new PublicKey(TOKEN_2022_PROGRAM_ID);
  const mint = new PublicKey(mintAddress);
  const user = wallet.publicKey;

  const { bondingCurveAccountInfo, bondingCurve } = await onlineSdk.fetchSellState(
    mint,
    user,
    tokenProgram
  );

  const solAmount = pumpSdk.getSellSolAmountFromTokenAmount({
    global,
    feeConfig: null,
    mintSupply: bondingCurve.tokenTotalSupply,
    bondingCurve,
    amount,
  });

  const slippage = config.trading.slippageBps / 100;
  const instructions = await pumpSdk.PUMP_SDK.sellInstructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    mint,
    user,
    amount,
    solAmount,
    slippage,
    tokenProgram,
    mayhemMode: false,
    cashback: bondingCurve.isCashbackCoin,
  });

  const tx = new Transaction().add(...instructions);
  const { blockhash } = await connection.getLatestBlockhash(config.rpc.commitment);
  tx.recentBlockhash = blockhash;
  tx.feePayer = user;

  const sig = await connection.sendTransaction(tx, [wallet], {
    skipPreflight: true,
    preflightCommitment: config.rpc.commitment,
    maxRetries: 3,
  });
  console.log(`🟢 SELL SENT ${mintAddress} | ${sig}`);
  if (!skipPositionClosed) setPositionClosed();
}

/**
 * Execute sell for copy trade (partial amount).
 * @param {string} mintAddress
 * @param {BN} amount - token amount (raw/base units)
 * @returns {Promise<void>}
 */
export async function executeSellAmount(mintAddress, amount) {
  if (!amount || amount.isZero()) return;
  await executeSell({ mintAddress, amount, skipPositionClosed: true });
}

export async function initTrader() {
  const kp = await getKeypair();
  if (!kp) {
    console.warn("⚠️  PRIVATE_KEY or KEYPAIR_PATH not set. Trading disabled.");
    return false;
  }
  wallet = kp;

  connection = new Connection(config.rpc.url, {
    commitment: config.rpc.commitment,
    confirmTransactionInitialTimeout: 15_000,
  });

  onlineSdk = new pumpSdk.OnlinePumpSdk(connection);
  global = await onlineSdk.fetchGlobal();

  const tokenAmt = config.trading.buyTokenAmount.toString();
  const maxSol = config.trading.buyMaxSolLamports.toString();
  const delayMin = config.trading.autoSellDelayMs / 60_000;
  const autoSell = config.trading.autoSellEnabled
    ? `auto-sell ${delayMin}min (${config.trading.autoSellDelayMs}ms)`
    : "off";
  console.log("✅ Trader ready | Token:", tokenAmt, "| Max SOL:", maxSol, "| Auto-sell:", autoSell);
  return true;
}

function cleanDedupe() {
  const now = Date.now();
  if (now - lastDedupeClean > DEDUPE_MS) {
    recentMints.clear();
    lastDedupeClean = now;
  }
}

/**
 * Execute buy.
 * @param {{ mint: string, creator?: string, associatedBondingCurve?: string, blockhash?: string }} mintInfo
 * @returns {Promise<boolean|null>}
 */
export async function executeBuy(mintInfo) {
  if (!config.trading.enabled || !wallet || !global) return null;
  if (hasPosition()) {
    return null; // skip: waiting for sell before next buy
  }

  const mintAddress = mintInfo.mint;
  const creatorAddress = mintInfo.creator;
  if (!creatorAddress) {
    console.warn(`⚠️ ${mintAddress} no creator in create tx, skipping local-only buy`);
    return null;
  }

  const tokenProgram = new PublicKey(TOKEN_2022_PROGRAM_ID);

  cleanDedupe();
  if (recentMints.has(mintAddress)) return null;
  recentMints.add(mintAddress);

  const mint = new PublicKey(mintAddress);
  const creator = new PublicKey(creatorAddress);
  const user = wallet.publicKey;

  const amount = new BN(config.trading.buyTokenAmount.toString());
  const solAmount = new BN(config.trading.buyMaxSolLamports.toString());
  const instructionAssociatedBondingCurve = mintInfo.associatedBondingCurve;
  const feeRecipient = getFeeRecipient(global);

  const associatedUser = getAssociatedTokenAddressSync(mint, user, true, tokenProgram);
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    user,
    associatedUser,
    user,
    mint,
    tokenProgram
  );

  let buyIx = await pumpSdk.PUMP_SDK.getBuyInstructionRaw({
    user,
    mint,
    creator,
    amount,
    solAmount,
    feeRecipient,
    tokenProgram,
  });
  const keys = [...buyIx.keys];
  let modified = false;
  if (instructionAssociatedBondingCurve && keys[4]) {
    keys[4] = {
      pubkey: new PublicKey(instructionAssociatedBondingCurve),
      isSigner: keys[4].isSigner,
      isWritable: keys[4].isWritable,
    };
    modified = true;
  }
  if (keys[8] && keys[8].pubkey.toBase58() !== TOKEN_2022_PROGRAM_ID) {
    keys[8] = {
      pubkey: new PublicKey(TOKEN_2022_PROGRAM_ID),
      isSigner: keys[8].isSigner,
      isWritable: keys[8].isWritable,
    };
    modified = true;
  }
  if (modified) {
    buyIx = new TransactionInstruction({
      programId: buyIx.programId,
      keys,
      data: buyIx.data,
    });
  }

  const priorityFeeSol = config.trading.buyPriorityFeeSol ?? 0.001;
  const estimatedCu = 100_000;
  const microLamports = Math.floor(((priorityFeeSol * 1e9) / estimatedCu) * 1e6);
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports });

  const tx = new Transaction().add(priorityIx, ataIx, buyIx);
  let blockhash = mintInfo.blockhash;
  if (!blockhash) {
    const latest = await connection.getLatestBlockhash("processed");
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
    console.error(`❌ Buy tx failed (${mintAddress}): send:`, e?.message ?? e);
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
    console.log(`🟢 BUY SENT ${mintAddress} | ${sig}`);
    if (config.trading.autoSellEnabled) {
      const delayMs = config.trading.autoSellDelayMs;
      setTimeout(
        () =>
          executeSell({ mintAddress, amount }).catch((e) => {
            console.error(`❌ Auto-sell failed (${mintAddress}):`, e?.message ?? e);
            setPositionClosed();
          }),
        delayMs
      );
    }
  } else {
    let errMsg = "";
    try {
      const txInfo = await connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (txInfo?.meta?.err) errMsg = ` | err: ${JSON.stringify(txInfo.meta.err)}`;
    } catch {
      /* ignore fetch error */
    }
    console.error(`❌ Buy failed (${mintAddress}): ${sig}${errMsg}`);
  }
  return success;
}

/**
 * Execute buy for copy trade (bypasses position lock).
 * Uses BUY_AMOUNT_SOL. Mirrors executeBuy structure.
 * @param {string} mintAddress
 * @param {string} [blockhash] - from detected tx (like executeBuy)
 * @returns {Promise<{ success: boolean, tokenAmountRaw: number }>}
 */
export async function executeBuyForCopyTrade(mintAddress, blockhash) {
  if (!config.trading.enabled || !wallet || !global || !onlineSdk || !connection) {
    return { success: false, tokenAmountRaw: 0 };
  }

  const mint = new PublicKey(mintAddress);
  const user = wallet.publicKey;
  const tokenProgram = new PublicKey(TOKEN_2022_PROGRAM_ID);

  let bondingCurve;
  try {
    bondingCurve = await onlineSdk.fetchBondingCurve(mint);
  } catch (e) {
    console.error(`❌ Copy buy failed (${mintAddress}): bonding curve:`, e?.message ?? e);
    return { success: false, tokenAmountRaw: 0 };
  }

  if (bondingCurve.virtualTokenReserves.isZero()) {
    console.warn(`⚠️ Copy buy skipped (${mintAddress}): migrated (no bonding curve)`);
    return { success: false, tokenAmountRaw: 0 };
  }

  const creator = bondingCurve.creator;
  const solAmount = new BN(Math.floor(config.trading.buyAmountSol * 1e9));
  const amount = pumpSdk.getBuyTokenAmountFromSolAmount({
    global,
    feeConfig: null,
    mintSupply: bondingCurve.tokenTotalSupply,
    bondingCurve,
    amount: solAmount,
  });

  if (amount.isZero()) {
    console.warn(`⚠️ Copy buy skipped (${mintAddress}): zero token amount`);
    return { success: false, tokenAmountRaw: 0 };
  }

  const bcPda = bondingCurvePda(mint);
  const instructionAssociatedBondingCurve = getAssociatedTokenAddressSync(
    mint,
    bcPda,
    true,
    tokenProgram
  );

  const feeRecipient = getFeeRecipient(global);
  const associatedUser = getAssociatedTokenAddressSync(mint, user, true, tokenProgram);
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    user,
    associatedUser,
    user,
    mint,
    tokenProgram
  );

  let buyIx;
  try {
    buyIx = await pumpSdk.PUMP_SDK.getBuyInstructionRaw({
      user,
      mint,
      creator,
      amount,
      solAmount,
      feeRecipient,
      tokenProgram,
    });
  } catch (e) {
    console.error(`❌ Copy buy failed (${mintAddress}):`, e?.message ?? e);
    return { success: false, tokenAmountRaw: 0 };
  }

  const keys = [...buyIx.keys];
  let modified = false;
  if (instructionAssociatedBondingCurve && keys[4]) {
    keys[4] = {
      pubkey: instructionAssociatedBondingCurve,
      isSigner: keys[4].isSigner,
      isWritable: keys[4].isWritable,
    };
    modified = true;
  }
  if (keys[8] && keys[8].pubkey.toBase58() !== TOKEN_2022_PROGRAM_ID) {
    keys[8] = {
      pubkey: new PublicKey(TOKEN_2022_PROGRAM_ID),
      isSigner: keys[8].isSigner,
      isWritable: keys[8].isWritable,
    };
    modified = true;
  }
  if (modified) {
    buyIx = new TransactionInstruction({
      programId: buyIx.programId,
      keys,
      data: buyIx.data,
    });
  }

  const priorityFeeSol = config.trading.buyPriorityFeeSol ?? 0.001;
  const estimatedCu = 100_000;
  const microLamports = Math.floor(((priorityFeeSol * 1e9) / estimatedCu) * 1e6);
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports });

  const tx = new Transaction().add(priorityIx, ataIx, buyIx);
  let txBlockhash = blockhash;
  if (!txBlockhash) {
    const latest = await connection.getLatestBlockhash("processed");
    txBlockhash = latest.blockhash;
  }
  tx.recentBlockhash = txBlockhash;
  tx.feePayer = user;

  let sig;
  try {
    sig = await connection.sendTransaction(tx, [wallet], {
      skipPreflight: true,
      preflightCommitment: config.rpc.commitment,
      maxRetries: 3,
    });
  } catch (e) {
    console.error(`❌ Copy buy tx failed (${mintAddress}): send:`, e?.message ?? e);
    return { success: false, tokenAmountRaw: 0 };
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
    console.log(`🟢 COPY BUY SENT ${mintAddress} | ${sig}`);
    return { success: true, tokenAmountRaw: Number(amount.toString()) };
  }
  let errMsg = "";
  try {
    const txInfo = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (txInfo?.meta?.err) errMsg = ` | err: ${JSON.stringify(txInfo.meta.err)}`;
  } catch {
    /* ignore fetch error */
  }
  console.error(`❌ Copy buy failed (${mintAddress}): ${sig}${errMsg}`);
  return { success: false, tokenAmountRaw: 0 };
}
