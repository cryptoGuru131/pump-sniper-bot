//! Pump.fun Sniper - low-latency new token detection + buy (Rust port).
//!
//! Uses Yellowstone gRPC for real-time new token detection and pumpfun crate for buys.

mod config;
mod detector;
mod trader;

use anyhow::Result;
use futures::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use yellowstone_grpc_client::{ClientTlsConfig, GeyserGrpcClient};
use yellowstone_grpc_proto::geyser::subscribe_update::UpdateOneof;
use yellowstone_grpc_proto::geyser::{
    CommitmentLevel, SubscribeRequest, SubscribeRequestFilterTransactions, SubscribeRequestPing,
};

use config::Config;
use detector::get_mint_from_update;
use trader::{LatencyReport, Trader};

const LATENCY_SAMPLE_SIZE: usize = 100;
const PING_INTERVAL_SECS: u64 = 30;

fn log_latencies(r: &LatencyReport) {
    let created_ws = r
        .created_at_ms
        .and_then(|c| r.ws_receive_ms.checked_sub(c));
    let ws_gettx = r.get_tx_ms.saturating_sub(r.ws_receive_ms);
    let gettx_sent = r.tx_sent_ms.saturating_sub(r.get_tx_ms);
    let sent_conf = r
        .tx_confirmed_ms
        .map(|c| c.saturating_sub(r.tx_sent_ms));

    let cw = created_ws.map(|n| n.to_string()).unwrap_or_else(|| "-".to_string());
    let sc = sent_conf.map(|n| n.to_string()).unwrap_or_else(|| "-".to_string());
    let ok = if r.success { "✓" } else { "✗" };

    println!(
        "⏱️  LATENCY {} {} | created→ws: {}ms | ws→getTx: {}ms | getTx→sent: {}ms | sent→confirmed: {}ms",
        r.mint, ok, cw, ws_gettx, gettx_sent, sc
    );
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    if dotenvy::var("GRPC_TOKEN").is_err() {
        dotenvy::from_path(std::path::Path::new("../.env")).ok();
    }
    let config = Config::from_env()?;

    let trading_ready = Trader::init(&config).await;
    if trading_ready {
        println!("✅ Trader ready. Buy amount: {} SOL", config.buy_amount_sol);
    } else {
        println!("⚠️  PRIVATE_KEY not set. Trading disabled.");
    }

    println!(
        "Connecting to: {} ({})",
        config.grpc_endpoint,
        config.grpc_provider.as_deref().unwrap_or("custom")
    );

    let mut client = GeyserGrpcClient::build_from_shared(config.grpc_endpoint.clone())?
        .x_token(Some(config.grpc_token.clone()))?
        .tls_config(ClientTlsConfig::new().with_native_roots())?
        .connect()
        .await?;

    println!("✅ Connected to gRPC");
    println!("🔍 Listening for new pump.fun tokens...");
    if trading_ready {
        println!("   Trading: ENABLED");
    } else {
        println!("   Trading: DISABLED");
    }
    println!();

    let (mut tx, mut stream) = client.subscribe().await?;

    let request = SubscribeRequest {
        transactions: HashMap::from([(
            "pumpFun".to_string(),
            SubscribeRequestFilterTransactions {
                vote: Some(false),
                failed: Some(false),
                account_required: vec![
                    config::PUMP_PROGRAM_ID.to_string(),
                    config::PUMP_FUN_MINT_AUTHORITY.to_string(),
                ],
                ..Default::default()
            },
        )]),
        commitment: Some(CommitmentLevel::Processed as i32),
        ..Default::default()
    };

    tx.send(request).await?;
    println!("📡 Subscribed (PROCESSED commitment)\n");

    let trader = trading_ready.then(|| Arc::new(Trader::from_config(&config)));
    let mut latency_samples: Vec<u64> = Vec::with_capacity(LATENCY_SAMPLE_SIZE);
    let mut last_ping = Instant::now();

    while let Some(msg) = stream.next().await {
        let update = match msg {
            Ok(u) => u,
            Err(e) => {
                eprintln!("Stream error: {}", e);
                continue;
            }
        };

        if update.update_oneof.is_none() && !update.filters.is_empty() {
            continue;
        }

        if let Some(UpdateOneof::Pong(_)) = update.update_oneof {
            continue;
        }

        let ws_receive_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        if let Some(mint_info) = get_mint_from_update(&update) {
            let report = if let Some(ref t) = trader {
                t.execute_buy(&mint_info, ws_receive_ms).await
            } else {
                None
            };

            let latency_ms = mint_info
                .created_at_ms
                .and_then(|created| ws_receive_ms.checked_sub(created));

            if let Some(lat) = latency_ms {
                latency_samples.push(lat);
                if latency_samples.len() > LATENCY_SAMPLE_SIZE {
                    latency_samples.remove(0);
                }
            }

            let avg = if latency_samples.is_empty() {
                "-".to_string()
            } else {
                let sum: u64 = latency_samples.iter().sum();
                (sum / latency_samples.len() as u64).to_string()
            };

            let lat_str = latency_ms
                .map(|l| l.to_string())
                .unwrap_or_else(|| "-".to_string());
            let tag = if mint_info.is_token_2022 { " [Token-2022]" } else { "" };
            println!(
                "🪙 {} | slot {} | gRPC {}ms (avg {}){} | https://pump.fun/{}",
                mint_info.mint, mint_info.slot, lat_str, avg, tag, mint_info.mint
            );

            if let Some(r) = report {
                log_latencies(&r);
            }
        }

        if last_ping.elapsed() > Duration::from_secs(PING_INTERVAL_SECS) {
            let ping = SubscribeRequest {
                ping: Some(SubscribeRequestPing { id: 1 }),
                ..Default::default()
            };
            let _ = tx.send(ping).await;
            last_ping = Instant::now();
        }
    }

    println!("Stream ended");
    Ok(())
}
