/**
 * Shared utilities for transaction parsing.
 * @module detectors/utils
 */

import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

export function getAccountKeys(transaction, meta) {
  const msg = transaction?.message;
  if (!msg?.accountKeys?.length) return [];
  const keys = msg.accountKeys
    .map((k) =>
      k && (k.length === 32 || (typeof k === "object" && k.byteLength === 32))
        ? new PublicKey(k)
        : null
    )
    .filter(Boolean);
  const writable = meta?.loadedWritableAddresses ?? [];
  const readonly = meta?.loadedReadonlyAddresses ?? [];
  writable.forEach((k) => keys.push(new PublicKey(k)));
  readonly.forEach((k) => keys.push(new PublicKey(k)));
  return keys;
}

export function getAccountIndexAt(accounts, index) {
  if (!accounts) return null;
  return index < accounts.length ? accounts[index] : null;
}

export function parseBlockhash(recentBlockhash) {
  if (!recentBlockhash) return undefined;
  const buf = Buffer.isBuffer(recentBlockhash)
    ? recentBlockhash
    : recentBlockhash.data
      ? Buffer.from(recentBlockhash.data)
      : null;
  return buf?.length === 32 ? bs58.encode(buf) : undefined;
}

export function getAllInstructions(message, meta) {
  return [
    ...(message.instructions ?? []),
    ...(meta?.innerInstructions ?? []).flatMap((ii) => ii.instructions ?? []),
  ];
}
