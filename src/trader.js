/**
 * Trader - buy execution using @pump-fun/pump-sdk.
 * Pre-fetches global/feeConfig at init for minimal latency.
 * Supports Token-2022 (create_v2), bonding curve polling, latency reporting.
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const BN = require("bn.js");
const { Connection, PublicKey, Transaction } = require("@solana/web3.js");
const pumpSdk = require("@pump-fun/pump-sdk");

import {
  config,
  getKeypair,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "./config.js";

const FETCH_RETRIES = 3;
const FETCH_RETRY_MS = 50;
const DEDUPE_MS = 5000;
const BONDING_CURVE_POLL_MS = 40;
const BONDING_CURVE_MAX_RETRIES = 12;
const CONFIRM_POLL_MS = 100;

let connection = null;
let onlineSdk = null;
let global = null;
let feeConfig = null;
let wallet = null;
const recentMints = new Set();
let lastDedupeClean = Date.now();

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

  const [g, fc] = await Promise.all([
    onlineSdk.fetchGlobal(),
    onlineSdk.fetchFeeConfig().catch(() => null),
  ]);
  global = g;
  feeConfig = fc;
  console.log("✅ Trader ready. Global pre-fetched. Buy amount:", config.trading.buyAmountSol, "SOL");
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
 * @typedef {Object} LatencyReport
 * @property {string} mint
 * @property {number|null} createdAtMs
 * @property {number} wsReceiveMs
 * @property {number} getTxMs
 * @property {number} txSentMs
 * @property {number|null} txConfirmedMs
 * @property {boolean} success
 */

/**
 * Execute buy and return latency report.
 * @param {{ mint: string, isToken2022?: boolean, createdAtMs?: number|null }} mintInfo
 * @param {number} wsReceiveMs
 * @returns {Promise<LatencyReport|null>}
 */
export async function executeBuy(mintInfo, wsReceiveMs) {
  if (!config.trading.enabled || !wallet || !global || !onlineSdk) return null;

  const mintAddress = mintInfo.mint;
  const isToken2022 = mintInfo.isToken2022 === true;
  const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const tokenProgram = new PublicKey(tokenProgramId);

  cleanDedupe();
  if (recentMints.has(mintAddress)) return null;
  recentMints.add(mintAddress);

  const mint = new PublicKey(mintAddress);
  const user = wallet.publicKey;
  const solAmount = new BN(Math.floor(config.trading.buyAmountSol * 1e9));
  const slippage = config.trading.slippageBps / 100; // SDK expects e.g. 5 for 5%

  const t0 = Date.now();

  // 1. Wait for bonding curve to exist so we get correct creator
  const bondingCurvePda = pumpSdk.bondingCurvePda(mint);
  for (let attempt = 0; attempt < BONDING_CURVE_MAX_RETRIES; attempt++) {
    try {
      const info = await connection.getAccountInfo(bondingCurvePda);
      if (info) break;
    } catch (_) {}
    if (attempt === BONDING_CURVE_MAX_RETRIES - 1) {
      console.warn(
        `⚠️ ${mintAddress} bonding curve not found after ${BONDING_CURVE_POLL_MS * BONDING_CURVE_MAX_RETRIES}ms, proceeding anyway`
      );
    }
    await sleep(BONDING_CURVE_POLL_MS);
  }
  const t1 = Date.now();
  const bondingCurveMs = t1 - t0;

  // 2. Fetch state (bonding curve + ATA)
  let state = null;
  for (let i = 0; i < FETCH_RETRIES; i++) {
    try {
      state = await onlineSdk.fetchBuyState(mint, user, tokenProgram);
      break;
    } catch (e) {
      if (i === FETCH_RETRIES - 1) {
        console.error(`❌ Buy failed (${mintAddress}): fetchBuyState error:`, (e && e.message) || e);
        return null;
      }
      await sleep(FETCH_RETRY_MS);
    }
  }
  const t2 = Date.now();
  const stateMs = t2 - t1;

  // 3. Calculate amount
  const amount = pumpSdk.getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: (state.bondingCurve && state.bondingCurve.tokenTotalSupply) || null,
    bondingCurve: state.bondingCurve,
    amount: solAmount,
  });
  const t3 = Date.now();
  const amountMs = t3 - t2;

  // 4. Build instructions
  const instructions = await pumpSdk.PUMP_SDK.buyInstructions({
    global,
    bondingCurveAccountInfo: state.bondingCurveAccountInfo,
    bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo,
    mint,
    user,
    amount,
    solAmount,
    slippage,
    tokenProgram,
  });
  const t4 = Date.now();
  const instructionsMs = t4 - t3;

  const getTxMs = Date.now();
  const tx = new Transaction().add(...instructions);

  console.log(
    `⏱️  BUILD ${mintAddress} | bondingCurve: ${bondingCurveMs}ms | state: ${stateMs}ms | amount: ${amountMs}ms | instructions: ${instructionsMs}ms`
  );

  // sendTransaction commented out - testing tx build only
  // let sig;
  // try {
  //   sig = await connection.sendTransaction(tx, [wallet], {
  //     skipPreflight: true,
  //     preflightCommitment: config.rpc.commitment,
  //     maxRetries: 3,
  //   });
  // } catch (e) {
  //   console.error(`❌ Buy tx failed (${mintAddress}): send:`, (e && e.message) || e);
  //   return {
  //     mint: mintAddress,
  //     createdAtMs: mintInfo.createdAtMs != null ? mintInfo.createdAtMs : null,
  //     wsReceiveMs,
  //     getTxMs,
  //     txSentMs: getTxMs,
  //     txConfirmedMs: null,
  //     success: false,
  //   };
  // }
  // const txSentMs = Date.now();
  // let txConfirmedMs = null;
  // let success = false;
  // for (let i = 0; i < 120; i++) {
  //   await sleep(CONFIRM_POLL_MS);
  //   const status = await connection.getSignatureStatus(sig);
  //   if (status && status.value) {
  //     txConfirmedMs = Date.now();
  //     success = status.value.err == null;
  //     break;
  //   }
  // }
  // if (success) {
  //   console.log(`🟢 BUY SENT ${mintAddress} | ${sig}`);
  // } else {
  //   console.error(`❌ Buy tx failed (${mintAddress}): ${sig}`);
  // }

  const report = {
    mint: mintAddress,
    createdAtMs: mintInfo.createdAtMs != null ? mintInfo.createdAtMs : null,
    wsReceiveMs,
    getTxMs,
    txSentMs: getTxMs,
    txConfirmedMs: null,
    success: false,
  };

  return report;
}
