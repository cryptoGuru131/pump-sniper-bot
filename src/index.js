/**
 * Pump.fun Sniper
 * Low-latency new token detection + auto-buy via Yellowstone gRPC.
 *
 * @module index
 */

import "dotenv/config";

import BN from "bn.js";
import { config } from "./config/index.js";
import {
  getMintFromUpdate,
  getMigratedMintFromUpdate,
  getWalletActivityFromUpdate,
} from "./detectors/index.js";
import {
  initTrader,
  executeBuy,
  executeBuyForCopyTrade,
  executeSellAmount,
} from "./services/pumpFunBuySellEngine.js";
import { initPumpSwapTrader, executeBuyPumpSwap } from "./services/pumpSwapBuySellEngine.js";
import { createGrpcClient, startPingKeepalive } from "./services/grpc.js";
import {
  addTargetBuy,
  addTargetSell,
  addBotBuy,
  addBotSell,
  computeBotSellAmount,
  getPosition,
  removePosition,
} from "./services/copyTradeStore.js";

async function main() {
  const tradingReady = await initTrader();
  const pumpSwapReady = await initPumpSwapTrader();

  const provider = (process.env.GRPC_PROVIDER || "").toLowerCase();
  console.log("Connecting to:", config.grpc.endpoint, provider ? `(${provider})` : "");

  const { stream, version } = await createGrpcClient();

  const { created, migrated, copyTrade } = config.modes;
  console.log("✅ Connected to Triton gRPC, version:", version || "unknown");
  console.log("🔍 Modes:", [
    created && "created",
    migrated && "migrated",
    copyTrade && "copy-trade",
  ]
    .filter(Boolean)
    .join(", ") || "none");
  if (created) console.log("   Created: ENABLED", tradingReady ? "(buy on)" : "(buy off)");
  if (migrated) console.log("   Migrated: ENABLED", pumpSwapReady ? "(buy on)" : "(buy off)");
  if (copyTrade) console.log("   Copy trade: tracking", config.copyTradeWallet);
  console.log("");

  stream.on("data", async (data) => {
    if (data?.pong) return;
    const receivedAtMs = Date.now();
    const { created, migrated, copyTrade } = config.modes;

    if (created) {
      const mintInfo = getMintFromUpdate(data);
      if (mintInfo) {
        if (tradingReady) await executeBuy(mintInfo);
        console.log(
          `🪙 ${mintInfo.mint} | slot ${mintInfo.slot} | https://pump.fun/${mintInfo.mint}`
        );
        return;
      }
    }

    if (migrated) {
      const migratedInfo = getMigratedMintFromUpdate(data);
      if (migratedInfo) {
        const durationMs =
          migratedInfo.createdAtMs != null ? receivedAtMs - migratedInfo.createdAtMs : null;
        const durationStr = durationMs != null ? ` | gRPC ${durationMs}ms` : "";
        console.log(
          `🚀 MIGRATED ${migratedInfo.mint} | slot ${migratedInfo.slot}${durationStr} | https://pump.fun/${migratedInfo.mint}`
        );
        if (pumpSwapReady) await executeBuyPumpSwap(migratedInfo);
        return;
      }
    }

    if (copyTrade && config.copyTradeWallet) {
      const copyWallet = config.copyTradeWallet;
      const events = getWalletActivityFromUpdate(data, copyWallet);
      for (const e of events) {
        const durationMs = e.createdAtMs != null ? receivedAtMs - e.createdAtMs : null;
        const durationStr = durationMs != null ? ` | gRPC ${durationMs}ms` : "";
        const icon = e.type === "buy" ? "🟢" : "🔴";
        const txLink = e.signature
          ? `https://solscan.io/tx/${e.signature}`
          : `https://pump.fun/${e.mint}`;
        const amountStr = [
          e.solAmount != null ? `${e.solAmount.toFixed(4)} SOL` : null,
          e.tokenAmount != null ? `${e.tokenAmount.toLocaleString()} tokens` : null,
        ]
          .filter(Boolean)
          .join(" | ");
        console.log(
          `${icon} ${e.type.toUpperCase()} ${e.mint}${amountStr ? ` | ${amountStr}` : ""} | ${txLink}${durationStr}`
        );

        if (e.source !== "bonding_curve") continue;

        if (e.type === "buy" && e.rawTokenAmount) {
          addTargetBuy(e.mint, e.rawTokenAmount);
          const result = await executeBuyForCopyTrade(e.mint, e.blockhash);
          if (result.success && result.tokenAmountRaw > 0) {
            addBotBuy(e.mint, result.tokenAmountRaw);
          }
        } else if (e.type === "sell" && e.rawTokenAmount) {
          if (!getPosition(e.mint)) continue;
          const { amount: botSellRaw, removeAfter } = computeBotSellAmount(
            e.mint,
            e.rawTokenAmount
          );
          addTargetSell(e.mint, e.rawTokenAmount);
          if (botSellRaw > 0) {
            await executeSellAmount(e.mint, new BN(botSellRaw));
            addBotSell(e.mint, botSellRaw);
          }
          if (removeAfter) removePosition(e.mint);
        }
      }
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
