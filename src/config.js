/**
 * Config - centralized env and trading params.
 * Load once at startup to avoid repeated lookups.
 */
import "dotenv/config";

const GRPC_PROVIDERS = {
  triton: { endpoint: "https://api.rpcpool.com:443" },
  helius: { endpoint: "https://laserstream-mainnet-ewr.helius-rpc.com" },
};

function normalizeEndpoint(raw) {
  const s = (raw || "").trim();
  if (!s) return "https://laserstream-mainnet-ewr.helius-rpc.com";
  let url = s;
  if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
  url = url.replace(/\/$/, "");
  try {
    const u = new URL(url);
    if (!u.port) u.port = "443";
    return u.toString();
  } catch {
    return url.includes(":443") ? url : url + ":443";
  }
}

function getGrpcConfig() {
  const provider = (process.env.GRPC_PROVIDER || "").toLowerCase();
  const token = process.env.GRPC_TOKEN || "";
  if (provider === "triton") {
    return {
      endpoint: GRPC_PROVIDERS.triton.endpoint,
      token: process.env.GRPC_TOKEN_TRITON || token,
    };
  }
  if (provider === "helius") {
    return {
      endpoint: GRPC_PROVIDERS.helius.endpoint,
      token: process.env.GRPC_TOKEN_HELIUS || token,
    };
  }
  return {
    endpoint: normalizeEndpoint(process.env.GRPC_ENDPOINT),
    token,
  };
}

import { createRequire } from "module";
const require = createRequire(import.meta.url);

let _keypair = null;
export async function getKeypair() {
  if (_keypair) return _keypair;
  const { Keypair } = require("@solana/web3.js");
  const raw = process.env.PRIVATE_KEY || process.env.KEYPAIR_PATH;
  if (!raw) return null;
  if (raw.length > 50 && !raw.startsWith("[")) {
    const bs58 = require("bs58");
    const decode = bs58.default ? bs58.default.decode : bs58.decode;
    _keypair = Keypair.fromSecretKey(decode(raw));
  } else {
    const fs = require("fs");
    const path = require("path");
    const p = raw.startsWith("[") ? null : path.resolve(raw);
    const data = p ? JSON.parse(fs.readFileSync(p, "utf8")) : JSON.parse(raw);
    _keypair = Keypair.fromSecretKey(Uint8Array.from(data));
  }
  return _keypair;
}

const grpcConfig = getGrpcConfig();

export const config = {
  grpc: {
    endpoint: normalizeEndpoint(grpcConfig.endpoint),
    token: grpcConfig.token,
  },
  rpc: {
    url: (process.env.RPC_URL || "https://api.mainnet-beta.solana.com").trim(),
    commitment: "confirmed", // balance speed vs finality
  },
  trading: {
    buyAmountSol: Number(process.env.BUY_AMOUNT_SOL || "0.01"),
    slippageBps: Number(process.env.SLIPPAGE_BPS || "5000"), // 99% default for sniping
    enabled: process.env.TRADING_ENABLED !== "false",
    /** Fixed token amount for local-only buy (raw units, e.g. 10_000_000 = 10M tokens) */
    buyTokenAmount: process.env.BUY_TOKEN_AMOUNT ? BigInt(process.env.BUY_TOKEN_AMOUNT) : BigInt(400_000_000_000),
    /** Max SOL lamports for local-only buy (derived from buyAmountSol * (1 + slippage) if not set) */
    buyMaxSolLamports: process.env.BUY_MAX_SOL_LAMPORTS
      ? BigInt(process.env.BUY_MAX_SOL_LAMPORTS)
      : BigInt(10_100_000_000),
    /** Auto-sell tokens 3s after successful buy */
    autoSellEnabled: process.env.AUTO_SELL_ENABLED !== "false",
    autoSellDelayMs: Number(process.env.AUTO_SELL_DELAY_MS || "10000"),
    /** Priority fee for buy tx (SOL). ~0.001 SOL for typical 100k CU buy. */
    buyPriorityFeeSol: Number(process.env.BUY_PRIORITY_FEE_SOL || "0.0001"),
  },
  /** Only detect tokens whose mint address ends with this (case-insensitive). Empty = no filter. */
  tokenFilterAddressSuffix: (process.env.TOKEN_FILTER_ADDRESS_SUFFIX || "").toLowerCase(),
};

export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
