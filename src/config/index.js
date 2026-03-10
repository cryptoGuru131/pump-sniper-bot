/**
 * Centralized configuration from environment.
 * @module config
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

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

const grpcConfig = getGrpcConfig();

export const config = {
  grpc: {
    endpoint: normalizeEndpoint(grpcConfig.endpoint),
    token: grpcConfig.token,
  },
  rpc: {
    url: (process.env.RPC_URL || "https://api.mainnet-beta.solana.com").trim(),
    commitment: "processed",
  },
  trading: {
    buyAmountSol: Number(process.env.BUY_AMOUNT_SOL || "0.01"),
    slippageBps: Number(process.env.SLIPPAGE_BPS || "5000"),
    enabled: process.env.TRADING_ENABLED !== "false",
    buyTokenAmount: process.env.BUY_TOKEN_AMOUNT
      ? BigInt(process.env.BUY_TOKEN_AMOUNT)
      : BigInt(400_000_000_000),
    buyMaxSolLamports: process.env.BUY_MAX_SOL_LAMPORTS
      ? BigInt(process.env.BUY_MAX_SOL_LAMPORTS)
      : BigInt(30_000_000),
    autoSellEnabled: process.env.AUTO_SELL_ENABLED !== "false",
    autoSellDelayMs: Number(process.env.AUTO_SELL_DELAY_MS || "420000"), // 7 min default
    buyPriorityFeeSol: Number(process.env.BUY_PRIORITY_FEE_SOL || "0.0001"),
  },
  tokenFilterAddressSuffix: (process.env.TOKEN_FILTER_ADDRESS_SUFFIX || "").toLowerCase(),
};

export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

let _keypair = null;

export async function getKeypair() {
  if (_keypair) return _keypair;
  const raw = process.env.PRIVATE_KEY || process.env.KEYPAIR_PATH;
  if (!raw) return null;
  if (raw.length > 50 && !raw.startsWith("[")) {
    const decode = bs58.default ? bs58.default.decode : bs58.decode;
    _keypair = Keypair.fromSecretKey(decode(raw));
  } else {
    const p = raw.startsWith("[") ? null : path.resolve(raw);
    const data = p ? JSON.parse(fs.readFileSync(p, "utf8")) : JSON.parse(raw);
    _keypair = Keypair.fromSecretKey(Uint8Array.from(data));
  }
  return _keypair;
}
