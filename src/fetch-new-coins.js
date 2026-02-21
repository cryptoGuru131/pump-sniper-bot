/**
 * Pump.fun New Coin Fetcher
 * Uses Triton Dragon's Mouth gRPC to stream new token launches in real-time
 *
 * Docs: https://docs.triton.one/project-yellowstone/dragons-mouth-grpc-subscriptions
 *
 * Set in .env:
 *   GRPC_ENDPOINT=<your-endpoint>   Get from Triton portal (customers.triton.one), NOT api.rpcpool.com
 *   GRPC_TOKEN=<your-triton-token>
 *   RPC_ENDPOINT=...  (optional, for slot timestamp / latency)
 *
 * Latency: Triton targets ≤50ms when your server has ≤50ms RTT to the endpoint.
 * - Use YOUR endpoint from the Triton portal (GeoDNS routes to nearest region)
 * - Deploy your bot in same region as Solana validators (e.g. AWS us-east-1, EU)
 * - api.rpcpool.com is EU-only; if you're elsewhere, latency will be 100-200ms+
 */

import "dotenv/config";
import bs58 from "bs58";
import Client from "@triton-one/yellowstone-grpc";
import { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  PUMP_PROGRAM_ID,
  PUMP_FUN_MINT_AUTHORITY,
  CREATE_DISCRIMINATOR,
  CREATE_V2_DISCRIMINATOR,
} from "./constants.js";

// Create instruction accounts (from Pump.fun IDL): 0=mint, 1=mintAuthority, 2=bondingCurve, ...
const ACCOUNTS_TO_INCLUDE = [{ name: "mint", index: 0 }];
const INSTRUCTION_DISCRIMINATORS = [CREATE_DISCRIMINATOR, CREATE_V2_DISCRIMINATOR];

// Endpoint: https://api.rpcpool.com:443 (Triton public gRPC)
function normalizeEndpoint(raw) {
  const s = (raw || "https://api.rpcpool.com:443").trim();
  if (!s) return "https://api.rpcpool.com:443";
  let url = s;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  url = url.replace(/\/$/, "");
  try {
    const u = new URL(url);
    if (!u.port) u.port = "443";
    return u.toString();
  } catch {
    return url.includes(":443") ? url : url + ":443";
  }
}

const GRPC_ENDPOINT = normalizeEndpoint(process.env.GRPC_ENDPOINT);
const GRPC_TOKEN = process.env.GRPC_TOKEN || "";
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";

if (!GRPC_TOKEN) {
  console.warn("⚠️  GRPC_TOKEN not set. Get your token at https://triton.one");
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
 * Read account index at position N from instruction.accounts.
 * QuickNode uses instruction.accounts[account.index] - direct index.
 * Yellowstone may return raw [idx0, idx1, ...] (no length) or Solana wire [len, idx0, ...].
 */
function getAccountIndexAt(accounts, index) {
  if (!accounts) return null;
  if (Array.isArray(accounts)) {
    return index < accounts.length ? accounts[index] : null;
  }
  const bytes = accounts;
  if (index >= bytes.length) return null;
  // Try direct index first (raw format). If that yields mint_authority for mint slot, try +1.
  return bytes[index];
}

/**
 * Check if instruction data matches one of the create discriminators (QuickNode pattern)
 */
function checkInstructionMatchesInstructionHandlers(instruction, discriminators) {
  if (!instruction?.data || instruction.data.length < 8) return false;
  const disc = instruction.data.slice(0, 8);
  return discriminators.some((d) => Buffer.from(d).equals(Buffer.from(disc)));
}

/**
 * Map account names to base58 addresses (QuickNode pattern)
 */
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
 * Extract mint info from Yellowstone SubscribeUpdate (QuickNode guide pattern)
 * @returns {{ mint: string, transaction: string, slot: number } | null}
 */
function getMintInfoFromUpdate(update, instructionDiscriminators, accountsToInclude) {
  if (!update.filters?.includes("pumpFun")) return null;

  const txInfo = update.transaction?.transaction;
  const transaction = txInfo?.transaction;
  const message = transaction?.message;
  const slot = update.transaction?.slot;

  if (!transaction || !message || !slot) return null;
  if (txInfo.meta?.err) return null; // Skip failed txs

  const accountKeys = getAccountKeys(transaction, txInfo.meta);

  // Find create instruction (top-level or inner)
  const allInstructions = [
    ...(message.instructions || []),
    ...(txInfo.meta?.innerInstructions || []).flatMap((ii) => ii.instructions || []),
  ];

  for (const ix of allInstructions) {
    if (!checkInstructionMatchesInstructionHandlers(ix, instructionDiscriminators)) continue;

    const accountsByName = getAccountsByName(accountsToInclude, ix, accountKeys);
    const mint = accountsByName.mint;
    if (!mint || mint === PUMP_FUN_MINT_AUTHORITY) continue; // mint is never the authority

    const sig = txInfo.signature
      ? bs58.encode(Buffer.from(txInfo.signature))
      : "unknown";

    return {
      mint,
      transaction: sig,
      slot: Number(slot),
    };
  }

  return null;
}

async function main() {
  console.log("Connecting to:", GRPC_ENDPOINT);
  const client = new Client(GRPC_ENDPOINT, GRPC_TOKEN, {
    grpcMaxDecodingMessageSize: 64 * 1024 * 1024, // 64 MiB (per Triton sample)
  });

  await client.connect();
  const version = await client.getVersion();
  console.log("✅ Connected to Triton gRPC, version:", version || "unknown");
  console.log("🔍 Listening for new pump.fun token launches...");
  console.log("   Endpoint:", GRPC_ENDPOINT, "(use your Triton portal endpoint for lowest latency)");
  console.log("   Tip: Run 'ping', (host from URL) to check RTT. Target ≤50ms for ~50ms gRPC latency.\n");

  const stream = await client.subscribe();
  const rpcConnection = new Connection(RPC_ENDPOINT);

  // Cache slot -> blockTime (Unix seconds) for latency measurement
  const slotToBlockTime = new Map();
  const latencySamples = [];
  const LATENCY_SAMPLE_SIZE = 100;

  stream.on("data", async (data) => {
    const arrivalMs = Date.now(); // Capture immediately - first line of handler
    try {
      // Cache block metadata for slot timestamp
      if (data?.blockMeta?.slot != null && data?.blockMeta?.blockTime?.timestamp != null) {
        slotToBlockTime.set(String(data.blockMeta.slot), Number(data.blockMeta.blockTime.timestamp));
      }

      const mintInfo = getMintInfoFromUpdate(
        data,
        INSTRUCTION_DISCRIMINATORS,
        ACCOUNTS_TO_INCLUDE
      );

      if (mintInfo) {
        let slotTimestamp = slotToBlockTime.get(String(mintInfo.slot));
        if (slotTimestamp == null) {
          // getBlockTime needs confirmed block; at PROCESSED we're ahead of RPC. Retry with short delays.
          for (const delayMs of [0, 400, 800]) {
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            try {
              slotTimestamp = await rpcConnection.getBlockTime(mintInfo.slot);
              if (slotTimestamp != null) break;
            } catch {
              // RPC may fail for very recent slots
            }
          }
        }
        const slotTimestampMs = slotTimestamp != null ? slotTimestamp * 1000 : null;

        console.log("🪙 NEW TOKEN DETECTED");
        console.log("   Mint:", mintInfo.mint);
        console.log("   Slot:", mintInfo.slot);
        console.log("   Slot timestamp:", slotTimestampMs != null ? new Date(slotTimestampMs).toISOString() : "N/A");
        console.log("   Arrival timestamp:", new Date(arrivalMs).toISOString());
        if (slotTimestampMs != null) {
          const latencyMs = arrivalMs - slotTimestampMs;
          latencySamples.push(latencyMs);
          if (latencySamples.length > LATENCY_SAMPLE_SIZE) latencySamples.shift();
          const avgLatency = latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length;
          console.log("   Latency (ms):", latencyMs);
          console.log("   Avg latency (last", latencySamples.length, "samples):", Math.round(avgLatency), "ms");
        }
        console.log("   Transaction:", mintInfo.transaction);
        console.log("   Pump.fun: https://pump.fun/" + mintInfo.mint);
        console.log("");
      }
    } catch (err) {
      console.error("Error processing update:", err?.message || err);
    }

    // Handle pong (keepalive) - silent
    if (data?.pong) {}
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
      pumpFun: {
        vote: false,
        failed: false,
        accountInclude: [],
        accountExclude: [],
        accountRequired: [PUMP_PROGRAM_ID, PUMP_FUN_MINT_AUTHORITY],
      },
    },
    transactionsStatus: {},
    entry: {},
    blocks: {},
    blocksMeta: { meta: {} }, // For slot timestamp (blockTime) in latency measurement
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
  const msg = String(err?.message || err);
  if (msg.includes("403") || msg.includes("Forbidden")) {
    console.error("\n💡 403 Forbidden = invalid or missing Triton gRPC token.");
    console.error("   Get your token at https://triton.one (Customers Portal → create token for gRPC).");
  }
  process.exit(1);
});
