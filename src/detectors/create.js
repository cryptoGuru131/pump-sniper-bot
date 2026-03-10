/**
 * Detects new token creation (create/create_v2) from Yellowstone updates.
 * @module detectors/create
 */

import {
  PUMP_FUN_MINT_AUTHORITY,
  CREATE_DISCRIMINATOR,
  CREATE_V2_DISCRIMINATOR,
} from "../core/constants.js";
import { config } from "../config/index.js";
import { getAccountKeys, getAccountIndexAt, parseBlockhash, getAllInstructions } from "./utils.js";

const CREATE_ACCOUNTS = [
  { name: "mint", index: 0 },
  { name: "bondingCurve", index: 2 },
  { name: "associatedBondingCurve", index: 3 },
  { name: "creator", index: 7 },
];

const CREATE_V2_ACCOUNTS = [
  { name: "mint", index: 0 },
  { name: "bondingCurve", index: 2 },
  { name: "associatedBondingCurve", index: 3 },
  { name: "creator", index: 5 },
];

const DISCRIMINATORS = [CREATE_DISCRIMINATOR, CREATE_V2_DISCRIMINATOR];

function getMatchedDiscriminatorIndex(instruction) {
  if (!instruction?.data || instruction.data.length < 8) return -1;
  const disc = instruction.data.slice(0, 8);
  return DISCRIMINATORS.findIndex((d) => Buffer.from(d).equals(Buffer.from(disc)));
}

function getAccountsByName(instruction, accountKeys, discIdx) {
  const list = discIdx === 1 ? CREATE_V2_ACCOUNTS : CREATE_ACCOUNTS;
  const result = {};
  for (const { name, index } of list) {
    const keyIdx = getAccountIndexAt(instruction.accounts, index);
    if (keyIdx == null || keyIdx >= accountKeys.length) continue;
    const key = accountKeys[keyIdx];
    if (key) result[name] = key.toBase58();
  }
  return result;
}

/**
 * Extract mint and creator from create/create_v2 instruction.
 * @param {object} update - Yellowstone SubscribeUpdate
 * @returns {{ mint: string, creator?: string, slot: number, associatedBondingCurve?: string, blockhash?: string } | null}
 */
export function getMintFromUpdate(update) {
  if (!update.filters?.includes("pumpFun")) return null;

  const txInfo = update.transaction?.transaction;
  const transaction = txInfo?.transaction;
  const message = transaction?.message;
  const slot = update.transaction?.slot;

  if (!transaction || !message || !slot) return null;
  if (txInfo.meta?.err) return null;

  const accountKeys = getAccountKeys(transaction, txInfo.meta);
  const allInstructions = getAllInstructions(message, txInfo.meta);

  for (const ix of allInstructions) {
    const discIdx = getMatchedDiscriminatorIndex(ix);
    if (discIdx < 0) continue;
    const accountsByName = getAccountsByName(ix, accountKeys, discIdx);
    const mint = accountsByName.mint;
    if (!mint || mint === PUMP_FUN_MINT_AUTHORITY) continue;

    const suffix = config.tokenFilterAddressSuffix;
    if (suffix && !mint.toLowerCase().endsWith(suffix)) continue;

    return {
      mint,
      creator: accountsByName.creator,
      associatedBondingCurve: accountsByName.associatedBondingCurve,
      slot: Number(slot),
      blockhash: parseBlockhash(message.recentBlockhash),
    };
  }
  return null;
}
