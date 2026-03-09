/**
 * Detector - pure sync mint extraction from Yellowstone updates.
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const bs58 = require("bs58");
import { PublicKey } from "@solana/web3.js";
import {
  PUMP_FUN_MINT_AUTHORITY,
  CREATE_DISCRIMINATOR,
  CREATE_V2_DISCRIMINATOR,
} from "./constants.js";
import { config } from "./config.js";

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
  return index < accounts.length ? accounts[index] : null;
}

function getMatchedDiscriminatorIndex(instruction, discriminators) {
  if (!instruction || !instruction.data || instruction.data.length < 8) return -1;
  const disc = instruction.data.slice(0, 8);
  return discriminators.findIndex((d) => Buffer.from(d).equals(Buffer.from(disc)));
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

function parseBlockhash(recentBlockhash) {
  if (!recentBlockhash) return undefined;
  const buf = Buffer.isBuffer(recentBlockhash)
    ? recentBlockhash
    : recentBlockhash.data
      ? Buffer.from(recentBlockhash.data)
      : null;
  return buf && buf.length === 32 ? bs58.encode(buf) : undefined;
}

/**
 * Extract mint and creator from Yellowstone SubscribeUpdate. Sync, no I/O.
 * @returns {{ mint: string, creator?: string, slot: number, associatedBondingCurve?: string, blockhash?: string } | null}
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
    const accountsByName = getAccountsByName(ix, accountKeys, discIdx);
    const mint = accountsByName.mint;
    if (!mint || mint === PUMP_FUN_MINT_AUTHORITY) continue;

    const suffix = config.tokenFilterAddressSuffix;
    if (suffix && !mint.toLowerCase().endsWith(suffix)) continue;

    const blockhash = parseBlockhash(message.recentBlockhash);
    return {
      mint,
      creator: accountsByName.creator || undefined,
      associatedBondingCurve: accountsByName.associatedBondingCurve || undefined,
      slot: Number(slot),
      blockhash,
    };
  }
  return null;
}
