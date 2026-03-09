/**
 * Pump.fun Sniper - new token detection + buy via gRPC.
 */
import "dotenv/config";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const grpc = require("@triton-one/yellowstone-grpc");
const Client = grpc.default || grpc.Client || grpc;
const CommitmentLevel = grpc.CommitmentLevel || (grpc.default && grpc.default.CommitmentLevel) || { PROCESSED: 0 };

import { config } from "./config.js";
import { getMintFromUpdate } from "./detector.js";
import { initTrader, executeBuy } from "./trader.js";
import { PUMP_PROGRAM_ID, PUMP_FUN_MINT_AUTHORITY } from "./constants.js";

async function main() {
  const tradingReady = await initTrader();

  const provider = (process.env.GRPC_PROVIDER || "").toLowerCase();
  console.log("Connecting to:", config.grpc.endpoint, provider ? `(${provider})` : "");
  const client = new Client(config.grpc.endpoint, config.grpc.token, {
    grpcMaxDecodingMessageSize: 64 * 1024 * 1024,
  });

  await client.connect();
  const version = await client.getVersion();
  console.log("✅ Connected to Triton gRPC, version:", version || "unknown");
  console.log("🔍 Listening for new pump.fun tokens...");
  if (tradingReady) console.log("   Trading: ENABLED");
  else console.log("   Trading: DISABLED (no wallet)");
  console.log("");

  const stream = await client.subscribe();

  stream.on("data", async (data) => {
    if (data && data.pong) return;

    const mintInfo = getMintFromUpdate(data);
    if (mintInfo) {
      if (tradingReady) await executeBuy(mintInfo);
      console.log(`🪙 ${mintInfo.mint} | slot ${mintInfo.slot} | https://pump.fun/${mintInfo.mint}`);
    }
  });

  stream.on("error", (err) => console.error("Stream error:", err));
  stream.on("end", () => console.log("Stream ended"));

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
    blocksMeta: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.PROCESSED,
  };

  await new Promise((resolve, reject) => {
    stream.write(request, (err) => (err ? reject(err) : resolve()));
  });

  console.log("📡 Subscribed (PROCESSED commitment)\n");

  setInterval(() => {
    stream.write(
      {
        ping: { id: 1 },
        accounts: {},
        accountsDataSlice: [],
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        slots: {},
      },
      (err) => err && console.error("Ping error:", err)
    );
  }, 30000);
}

main().catch((err) => {
  console.error("Fatal:", (err && err.message) || err);
  if (String((err && err.message) || "").includes("403")) {
    console.error("\n💡 403 = invalid/missing GRPC_TOKEN. Get one at https://triton.one");
  }
  process.exit(1);
});
