/**
 * Detects token migrations (bonding curve → PumpSwap/Raydium) from Yellowstone updates.
 * @module detectors/migrate
 */

import { PUMP_FUN_MINT_AUTHORITY, MIGRATE_DISCRIMINATOR } from "../core/constants.js";
import { config } from "../config/index.js";
import { getAccountKeys, getAccountIndexAt, parseBlockhash, getAllInstructions } from "./utils.js";

const MIGRATE_ACCOUNTS = [
  { name: "mint", index: 2 },
  { name: "bondingCurve", index: 3 },
  { name: "associatedBondingCurve", index: 4 },
];

function matchesMigrateDiscriminator(instruction) {
  if (!instruction?.data || instruction.data.length < 8) return false;
  const disc = instruction.data.slice(0, 8);
  return Buffer.from(MIGRATE_DISCRIMINATOR).equals(Buffer.from(disc));
}

function getMigrateAccountsByName(instruction, accountKeys) {
  const result = {};
  for (const { name, index } of MIGRATE_ACCOUNTS) {
    const keyIdx = getAccountIndexAt(instruction.accounts, index);
    if (keyIdx == null || keyIdx >= accountKeys.length) continue;
    const key = accountKeys[keyIdx];
    if (key) result[name] = key.toBase58();
  }
  return result;
}

/**
 * Extract mint from migrate instruction.
 * @param {object} update - Yellowstone SubscribeUpdate
 * @returns {{ mint: string, bondingCurve?: string, associatedBondingCurve?: string, slot: number, blockhash?: string, type: 'migrate' } | null}
 */
export function getMigratedMintFromUpdate(update) {
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
    if (!matchesMigrateDiscriminator(ix)) continue;
    const accountsByName = getMigrateAccountsByName(ix, accountKeys);
    const mint = accountsByName.mint;
    if (!mint || mint === PUMP_FUN_MINT_AUTHORITY) continue;

    const suffix = config.tokenFilterAddressSuffix;
    if (suffix && !mint.toLowerCase().endsWith(suffix)) continue;

    const createdAt = update.createdAt ?? update.created_at;
    const createdAtMs = createdAt instanceof Date ? createdAt.getTime() : undefined;

    return {
      mint,
      bondingCurve: accountsByName.bondingCurve,
      associatedBondingCurve: accountsByName.associatedBondingCurve,
      slot: Number(slot),
      blockhash: parseBlockhash(message.recentBlockhash),
      type: "migrate",
      createdAtMs,
      blockhash: parseBlockhash(message.recentBlockhash),
    };
  }
  return null;
}
