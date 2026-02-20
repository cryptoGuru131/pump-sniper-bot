/**
 * Pump.fun New Coin Fetcher
 * Uses Triton Dragon's Mouth gRPC to stream new token launches in real-time
 *
 * Set GRPC_ENDPOINT and GRPC_TOKEN in .env
 * Triton endpoint: https://api.rpcpool.com:443
 */

import "dotenv/config";
import Client from "@triton-one/yellowstone-grpc";
import { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import { PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM_ID, isCreateInstruction } from "./constants.js";

const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT || "https://api.rpcpool.com:443";
const GRPC_TOKEN = process.env.GRPC_TOKEN || "";

if (!GRPC_TOKEN) {
  console.warn("⚠️  GRPC_TOKEN not set. Set it in .env for Triton authentication.");
}

/**
 * Resolve account keys from message + meta (handles v0 transactions with address table lookups)
 */
function getAccountKeys(transaction, meta) {
  const msg = transaction?.message;
  if (!msg?.accountKeys?.length) return [];

  const keys = msg.accountKeys.map((k) =>
    k && (k.length === 32 || (typeof k === "object" && k.byteLength === 32))
      ? new PublicKey(k)
      : null
  ).filter(Boolean);

  // Append loaded addresses from meta (for v0 transactions with address table lookups)
  const writable = meta?.loadedWritableAddresses || [];
  const readonly = meta?.loadedReadonlyAddresses || [];
  writable.forEach((k) => keys.push(new PublicKey(k)));
  readonly.forEach((k) => keys.push(new PublicKey(k)));

  return keys;
}

/**
 * Extract new mint from a pump.fun create transaction
 */
function extractNewMintFromTransaction(txInfo) {
  const tx = txInfo?.transaction;
  const meta = txInfo?.meta;

  if (!tx || !meta) return null;
  if (meta.err) return null; // Skip failed txs

  const msg = tx.message;
  if (!msg?.instructions?.length) return null;

  const accountKeys = getAccountKeys(tx, meta);
  const pumpProgramId = new PublicKey(PUMP_PROGRAM_ID);

  for (const ix of msg.instructions) {
    const programId = accountKeys[ix.programIdIndex];
    if (!programId?.equals(pumpProgramId)) continue;

    const data = ix.data && ix.data.length >= 8 ? ix.data : new Uint8Array(0);
    if (!isCreateInstruction(data)) continue;

    // Create instruction: first account is the mint (writable, signer)
    // accounts format: [compact_u16_length, idx0, idx1, ...] - first index after length
    const accountsBytes = ix.accounts || new Uint8Array(0);
    if (accountsBytes.length < 2) continue;

    const mintIndex = accountsBytes[1]; // First account index (after 1-byte length)
    const mintKey = accountKeys[mintIndex];
    if (mintKey) {
      return mintKey.toBase58();
    }
  }

  return null;
}

async function main() {
  const client = new Client(GRPC_ENDPOINT, GRPC_TOKEN, {
    "grpc.max_receive_message_length": 100 * 1024 * 1024,
  });

  await client.connect();
  const version = await client.getVersion();
  console.log("✅ Connected to Triton gRPC, version:", version || "unknown");
  console.log("🔍 Listening for new pump.fun token launches...\n");

  const stream = await client.subscribe();

  stream.on("data", (data) => {
    // Handle transaction updates
    if (data?.transaction?.transaction) {
      const txInfo = data.transaction.transaction;
      const slot = data.transaction.slot;

      const mint = extractNewMintFromTransaction(txInfo);
      if (mint) {
        const sig = txInfo.signature
          ? Buffer.from(txInfo.signature).toString("base64")
          : "unknown";
        console.log("🪙 NEW TOKEN DETECTED");
        console.log("   Mint:", mint);
        console.log("   Slot:", slot);
        console.log("   Signature (base64):", sig);
        console.log("   Pump.fun: https://pump.fun/" + mint);
        console.log("");
      }
    }

    // Handle pong (keepalive)
    if (data?.pong) {
      // Silent - connection alive
    }
  });

  stream.on("error", (err) => {
    console.error("Stream error:", err);
  });

  stream.on("end", () => {
    console.log("Stream ended");
  });

  // Subscribe to pump.fun transactions
  const request = {
    slots: { slots: {} },
    accounts: {},
    transactions: {
      pumpfun: {
        vote: false,
        failed: false,
        accountInclude: [PUMP_PROGRAM_ID],
        accountExclude: [],
        accountRequired: [],
      },
    },
    transactionsStatus: {},
    entry: {},
    blocks: {},
    blocksMeta: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.PROCESSED, // Fastest - intra-slot updates
  };

  await new Promise((resolve, reject) => {
    stream.write(request, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  console.log("📡 Subscribed to pump.fun program transactions (PROCESSED commitment)\n");

  // Ping every 30s to keep stream alive
  const pingRequest = {
    ping: { id: 1 },
    accounts: {},
    accountsDataSlice: [],
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    slots: {},
  };

  setInterval(() => {
    stream.write(pingRequest, (err) => {
      if (err) console.error("Ping error:", err);
    });
  }, 30000);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
