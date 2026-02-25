/**
 * Detector - pure sync mint extraction from Yellowstone updates.
 * Zero async in hot path for minimal latency.
 */
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import {
  PUMP_PROGRAM_ID,
  PUMP_FUN_MINT_AUTHORITY,
  CREATE_DISCRIMINATOR,
  CREATE_V2_DISCRIMINATOR,
} from "./constants.js";

const ACCOUNTS_TO_INCLUDE = [{ name: "mint", index: 0 }];
const INSTRUCTION_DISCRIMINATORS = [CREATE_DISCRIMINATOR, CREATE_V2_DISCRIMINATOR];

function getAccountKeys(transaction, meta) {
  const msg = transaction && transaction.message;
  if (!msg || !msg.accountKeys || !msg.accountKeys.length) return [];
  const keys = msg.accountKeys
    .map((k) =>
      k && (k.length === 32 || (typeof k === "object" && k.byteLength === 32))
        ? new PublicKey(k)
        : null
    )
    .filter(Boolean);
  const writable = (meta && meta.loadedWritableAddresses) || [];
  const readonly = (meta && meta.loadedReadonlyAddresses) || [];
  writable.forEach((k) => keys.push(new PublicKey(k)));
  readonly.forEach((k) => keys.push(new PublicKey(k)));
  return keys;
}

function getAccountIndexAt(accounts, index) {
  if (!accounts) return null;
  if (Array.isArray(accounts)) return index < accounts.length ? accounts[index] : null;
  return index < accounts.length ? accounts[index] : null;
}

function getMatchedDiscriminatorIndex(instruction, discriminators) {
  if (!instruction || !instruction.data || instruction.data.length < 8) return -1;
  const disc = instruction.data.slice(0, 8);
  return discriminators.findIndex((d) => Buffer.from(d).equals(Buffer.from(disc)));
}

function getAccountsByName(accountsToInclude, instruction, accountKeys) {
  const result = {};
  for (const { name, index } of accountsToInclude) {
    const keyIdx = getAccountIndexAt(instruction.accounts, index);
    if (keyIdx == null || keyIdx >= accountKeys.length) continue;
    const key = accountKeys[keyIdx];
    if (key) result[name] = key.toBase58();
  }
  return result;
}

/**
 * Extract mint from Yellowstone SubscribeUpdate. Sync, no I/O.
 * @returns {{ mint: string, transaction: string, slot: number, isToken2022: boolean, createdAtMs: number|null } | null}
 */
export function getMintFromUpdate(update) {
  if (!update.filters || !update.filters.includes("pumpFun")) return null;

  const txInfo = update.transaction && update.transaction.transaction;
  const transaction = txInfo && txInfo.transaction;
  const message = transaction && transaction.message;
  const slot = update.transaction && update.transaction.slot;

  if (!transaction || !message || !slot) return null;
  if (txInfo.meta && txInfo.meta.err) return null;

  const accountKeys = getAccountKeys(transaction, txInfo.meta);
  const allInstructions = [
    ...(message.instructions || []),
    ...((txInfo.meta && txInfo.meta.innerInstructions) || []).flatMap((ii) => (ii.instructions || [])),
  ];

  for (const ix of allInstructions) {
    const discIdx = getMatchedDiscriminatorIndex(ix, INSTRUCTION_DISCRIMINATORS);
    if (discIdx < 0) continue;
    const accountsByName = getAccountsByName(ACCOUNTS_TO_INCLUDE, ix, accountKeys);
    const mint = accountsByName.mint;
    if (!mint || mint === PUMP_FUN_MINT_AUTHORITY) continue;

    const isToken2022 = discIdx === 1; // CREATE_V2_DISCRIMINATOR
    const createdAtMs =
      update.createdAt != null ? new Date(update.createdAt).getTime() : null;
    const sig = txInfo.signature ? bs58.encode(Buffer.from(txInfo.signature)) : "unknown";
    return {
      mint,
      transaction: sig,
      slot: Number(slot),
      isToken2022,
      createdAtMs,
    };
  }
  return null;
}
