/**
 * Detects buy/sell activity from a wallet (for copy trading).
 * Parses Pump bonding curve and PumpSwap AMM transactions.
 * @module detectors/walletActivity
 */

import bs58 from "bs58";
import {
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FUN_MINT_AUTHORITY,
  BUY_DISCRIMINATOR,
  BUY_EXACT_SOL_IN_DISCRIMINATOR,
  SELL_DISCRIMINATOR,
} from "../core/constants.js";
import { getAccountKeys, getAccountIndexAt, parseBlockhash, getAllInstructions } from "./utils.js";

/** Pump bonding curve: mint=2, user=6 (IDL order: global, fee_recipient, mint, bonding_curve, associated_bonding_curve, associated_user, user) */
const PUMP_BUY_SELL_ACCOUNTS = [
  { name: "mint", index: 2 },
  { name: "user", index: 6 },
];

/** PumpSwap AMM: base_mint=3, user=1 */
const PUMP_AMM_BUY_SELL_ACCOUNTS = [
  { name: "mint", index: 3 },
  { name: "user", index: 1 },
];

function getInstructionDataBytes(instruction) {
  const d = instruction?.data;
  if (!d) return null;
  if (Buffer.isBuffer(d) || d instanceof Uint8Array) return Buffer.from(d);
  if (typeof d === "string") {
    try {
      const decode = bs58.default?.decode ?? bs58.decode;
      return Buffer.from(decode(d));
    } catch {
      return null;
    }
  }
  return null;
}

function matchesDiscriminator(instruction, disc) {
  const buf = getInstructionDataBytes(instruction);
  if (!buf || buf.length < 8) return false;
  return Buffer.from(disc).equals(buf.subarray(0, 8));
}

function getProgramId(instruction, accountKeys) {
  const programIdx = instruction.programIdIndex ?? instruction.programId;
  if (programIdx == null || programIdx >= accountKeys.length) return null;
  return accountKeys[programIdx]?.toBase58?.() ?? null;
}

function getAccountsByName(instruction, accountKeys, layout) {
  const result = {};
  for (const { name, index } of layout) {
    const keyIdx = getAccountIndexAt(instruction.accounts, index);
    if (keyIdx == null || keyIdx >= accountKeys.length) continue;
    const key = accountKeys[keyIdx];
    if (key) result[name] = key.toBase58();
  }
  return result;
}

/**
 * Extract buy/sell events from a transaction update.
 * @param {object} update - Yellowstone SubscribeUpdate
 * @param {string} [targetWallet] - If set, only emit events for this wallet
 * @returns {Array<{ type: 'buy'|'sell', wallet: string, mint: string, source: 'bonding_curve'|'pumpswap', slot: number, blockhash?: string, createdAtMs?: number }>}
 */
export function getWalletActivityFromUpdate(update, targetWallet) {
  const txInfo = update.transaction?.transaction;
  const transaction = txInfo?.transaction;
  const message = transaction?.message;
  const slot = update.transaction?.slot;

  if (!transaction || !message || !slot) return [];
  if (txInfo.meta?.err) return [];

  const accountKeys = getAccountKeys(transaction, txInfo.meta);
  const allInstructions = getAllInstructions(message, txInfo.meta);
  const createdAt = update.createdAt ?? update.created_at;
  const createdAtMs = createdAt instanceof Date ? createdAt.getTime() : undefined;
  const blockhash = parseBlockhash(message.recentBlockhash);
  const sigBytes = txInfo.signature;
  const signature =
    sigBytes && sigBytes.length >= 64
      ? (bs58.default?.encode ?? bs58.encode)(Buffer.from(sigBytes))
      : null;

  const events = [];

  for (const ix of allInstructions) {
    const isBuy =
      matchesDiscriminator(ix, BUY_DISCRIMINATOR) ||
      matchesDiscriminator(ix, BUY_EXACT_SOL_IN_DISCRIMINATOR);
    const isSell = matchesDiscriminator(ix, SELL_DISCRIMINATOR);
    if (!isBuy && !isSell) continue;

    const programId = getProgramId(ix, accountKeys);
    if (!programId) continue;

    const isPump = programId === PUMP_PROGRAM_ID;
    const isAmm = programId === PUMP_AMM_PROGRAM_ID;
    if (!isPump && !isAmm) continue;

    const layout = isAmm ? PUMP_AMM_BUY_SELL_ACCOUNTS : PUMP_BUY_SELL_ACCOUNTS;
    const accounts = getAccountsByName(ix, accountKeys, layout);
    const wallet = accounts.user;
    const mint = accounts.mint;

    if (!wallet || !mint || mint === PUMP_FUN_MINT_AUTHORITY) continue;
    if (targetWallet && wallet !== targetWallet) continue;

    const meta = txInfo.meta;
    let solAmount = null;
    let tokenAmount = null;

    const userIdx = accountKeys.findIndex((k) => k?.toBase58?.() === wallet);
    if (userIdx >= 0 && meta?.preBalances && meta?.postBalances) {
      const pre = Number(meta.preBalances[userIdx] ?? 0);
      const post = Number(meta.postBalances[userIdx] ?? 0);
      const lamportsChange = post - pre;
      solAmount = Math.abs(lamportsChange) / 1e9;
    }

    const preToken = meta?.preTokenBalances?.find(
      (b) => String(b?.owner) === wallet && String(b?.mint) === mint
    );
    const postToken = meta?.postTokenBalances?.find(
      (b) => String(b?.owner) === wallet && String(b?.mint) === mint
    );
    let rawTokenAmount = null;
    if (preToken || postToken) {
      const preAmt = Number(preToken?.uiTokenAmount?.amount ?? 0);
      const postAmt = Number(postToken?.uiTokenAmount?.amount ?? 0);
      const rawChange = isBuy ? postAmt - preAmt : preAmt - postAmt;
      const decimals = postToken?.uiTokenAmount?.decimals ?? preToken?.uiTokenAmount?.decimals ?? 6;
      tokenAmount = rawChange / 10 ** decimals;
      rawTokenAmount = Math.abs(rawChange);
    }

    events.push({
      type: isBuy ? "buy" : "sell",
      wallet,
      mint,
      source: isAmm ? "pumpswap" : "bonding_curve",
      slot: Number(slot),
      blockhash,
      createdAtMs,
      signature,
      solAmount: solAmount != null && solAmount > 0 ? solAmount : null,
      tokenAmount: tokenAmount != null && tokenAmount > 0 ? tokenAmount : null,
      rawTokenAmount: rawTokenAmount != null && rawTokenAmount > 0 ? rawTokenAmount : null,
    });
  }

  return events;
}
