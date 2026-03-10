/**
 * Pump.fun Sniper
 * Low-latency new token detection + auto-buy via Yellowstone gRPC.
 *
 * @module index
 */

import "dotenv/config";

import { config } from "./config/index.js";
import { getMintFromUpdate, getMigratedMintFromUpdate } from "./detectors/index.js";
import { initTrader, executeBuy } from "./services/pumpFunBuySellEngine.js";
import { initPumpSwapTrader, executeBuyPumpSwap } from "./services/pumpSwapBuySellEngine.js";
import { createGrpcClient, startPingKeepalive } from "./services/grpc.js";

async function main() {
  const tradingReady = await initTrader();
  const pumpSwapReady = await initPumpSwapTrader();

  const provider = (process.env.GRPC_PROVIDER || "").toLowerCase();
  console.log("Connecting to:", config.grpc.endpoint, provider ? `(${provider})` : "");

  const { stream, version } = await createGrpcClient();

  console.log("✅ Connected to Triton gRPC, version:", version || "unknown");
  console.log("🔍 Listening for new pump.fun tokens + migrations...");
  if (tradingReady) console.log("   Bonding curve buy: ENABLED");
  else console.log("   Bonding curve buy: DISABLED");
  if (pumpSwapReady) console.log("   PumpSwap buy: ENABLED");
  else console.log("   PumpSwap buy: DISABLED");
  console.log("");

  stream.on("data", async (data) => {
    if (data?.pong) return;
    const receivedAtMs = Date.now();
    // const mintInfo = getMintFromUpdate(data);
    // if (mintInfo) {
    //   if (tradingReady) await executeBuy(mintInfo);
    //   console.log(
    //     `🪙 ${mintInfo.mint} | slot ${mintInfo.slot} | https://pump.fun/${mintInfo.mint}`
    //   );
    //   return;
    // }
    const migratedInfo = getMigratedMintFromUpdate(data);
    if (migratedInfo) {
      const durationMs =
        migratedInfo.createdAtMs != null ? receivedAtMs - migratedInfo.createdAtMs : null;
      const durationStr = durationMs != null ? ` | gRPC ${durationMs}ms` : "";
      console.log(
        `🚀 MIGRATED ${migratedInfo.mint} | slot ${migratedInfo.slot}${durationStr} | https://pump.fun/${migratedInfo.mint}`
      );
      if (pumpSwapReady) await executeBuyPumpSwap(migratedInfo);
    }
  });

  stream.on("error", (err) => console.error("Stream error:", err));
  stream.on("end", () => console.log("Stream ended"));

  console.log("📡 Subscribed (PROCESSED commitment)\n");

  startPingKeepalive(stream);
}

main().catch((err) => {
  console.error("Fatal:", err?.message ?? err);
  if (String(err?.message ?? "").includes("403")) {
    console.error("\n💡 403 = invalid/missing GRPC_TOKEN. Get one at https://triton.one");
  }
  process.exit(1);
});
