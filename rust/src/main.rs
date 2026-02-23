//! Pump.fun token sniper - low-latency Yellowstone gRPC streaming (Rust)
//!
//! Set in .env:
//!   GRPC_ENDPOINT=https://api.rpcpool.com:443
//!   GRPC_TOKEN=<your-triton-token>

use anyhow::Result;
use futures::{sink::SinkExt, stream::StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tokio::sync::RwLock;
use yellowstone_grpc_client::{GeyserGrpcClient, ClientTlsConfig};
use yellowstone_grpc_proto::geyser::subscribe_update::UpdateOneof;
use yellowstone_grpc_proto::geyser::{
    CommitmentLevel, SubscribeRequest, SubscribeRequestFilterTransactions,
};

const PUMP_PROGRAM_ID: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_FUN_MINT_AUTHORITY: &str = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";

// create: [24, 30, 200, 40, 5, 28, 7, 119]
const CREATE_DISCRIMINATOR: [u8; 8] = [24, 30, 200, 40, 5, 28, 7, 119];
// create_v2: [214, 144, 76, 236, 95, 139, 49, 180]
const CREATE_V2_DISCRIMINATOR: [u8; 8] = [214, 144, 76, 236, 95, 139, 49, 180];

fn is_create_instruction(data: &[u8]) -> bool {
    if data.len() < 8 {
        return false;
    }
    let disc = &data[0..8];
    disc == CREATE_DISCRIMINATOR || disc == CREATE_V2_DISCRIMINATOR
}

/// Read account index at position N from instruction.accounts.
/// Yellowstone may use raw [idx0, idx1, ...] or Solana wire [len, idx0, ...].
fn get_account_index_at(accounts: &[u8], index: usize) -> Option<u8> {
    // Try direct index first (raw format) - matches Node.js behavior
    if index < accounts.len() {
        return Some(accounts[index]);
    }
    // Fallback: shortvec format [len, idx0, idx1, ...]
    if accounts.len() < 2 {
        return None;
    }
    let len = accounts[0];
    let offset = if len & 0x80 != 0 { 2 } else { 1 };
    let pos = offset + index;
    if pos < accounts.len() && index < len as usize {
        Some(accounts[pos])
    } else {
        None
    }
}

/// Extract mint from SubscribeUpdateTransactionInfo (used by both Transaction and Block updates)
fn extract_mint_from_tx_info(
    tx_info: &yellowstone_grpc_proto::geyser::SubscribeUpdateTransactionInfo,
    slot: u64,
) -> Option<(String, String, u64)> {
    let tx = tx_info.transaction.as_ref()?;
    let meta = tx_info.meta.as_ref()?;

    if meta.err.is_some() {
        return None;
    }

    let message = tx.message.as_ref()?;
    let mut account_keys: Vec<Vec<u8>> = message
        .account_keys
        .iter()
        .map(|k: &Vec<u8>| k.clone())
        .collect();
    account_keys.extend(
        meta.loaded_writable_addresses
            .iter()
            .map(|k: &Vec<u8>| k.clone()),
    );
    account_keys.extend(
        meta.loaded_readonly_addresses
            .iter()
            .map(|k: &Vec<u8>| k.clone()),
    );

    let mut all_instructions: Vec<(&[u8], &[u8])> = Vec::new();
    for ix in &message.instructions {
        all_instructions.push((ix.accounts.as_slice(), ix.data.as_slice()));
    }
    for inner in &meta.inner_instructions {
        for ix in &inner.instructions {
            all_instructions.push((ix.accounts.as_slice(), ix.data.as_slice()));
        }
    }

    for (accounts, data) in all_instructions {
        if !is_create_instruction(data) {
            continue;
        }

        let mint_idx = get_account_index_at(accounts, 0)?;
        let mint_key = account_keys.get(mint_idx as usize)?;
        if mint_key.len() != 32 {
            continue;
        }

        let mint = bs58::encode(mint_key).into_string();
        if mint == PUMP_FUN_MINT_AUTHORITY {
            continue;
        }

        let sig = bs58::encode(tx_info.signature.as_slice()).into_string();
        return Some((mint, sig, slot));
    }

    None
}

/// Extract mint from Pump.fun create instruction (Transaction update)
fn extract_mint_from_transaction(
    tx_update: &yellowstone_grpc_proto::geyser::SubscribeUpdateTransaction,
) -> Option<(String, String, u64)> {
    let tx_info = tx_update.transaction.as_ref()?;
    extract_mint_from_tx_info(tx_info, tx_update.slot)
}

/// Print mint info with created_at latency (gRPC server → client)
async fn print_mint_info(
    mint: &str,
    sig: &str,
    slot: u64,
    arrival_ms: i64,
    created_at_ms: Option<i64>,
    latency_samples: &Arc<RwLock<Vec<i64>>>,
) {
    let latency_ms = created_at_ms.map(|created| arrival_ms - created);

    println!("🪙 NEW TOKEN DETECTED");
    println!("   Mint: {}", mint);
    println!("   Slot: {}", slot);
    if let Some(created) = created_at_ms {
        println!("   Created at: {} ms", created);
    }
    println!("   Arrival: {} ms", arrival_ms);
    if let Some(lat) = latency_ms {
        println!("   Latency (arrival - created_at): {} ms", lat);
        latency_samples.write().await.push(lat);
        let mut samples = latency_samples.write().await;
        if samples.len() > 100 {
            samples.remove(0);
        }
        let avg = samples.iter().sum::<i64>() / samples.len().max(1) as i64;
        println!("   Avg latency (last {}): {} ms", samples.len(), avg);
    }
    println!("   Transaction: {}", sig);
    println!("   Pump.fun: https://pump.fun/{}", mint);
    println!();
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();

    let endpoint = std::env::var("GRPC_ENDPOINT")
        .unwrap_or_else(|_| "https://laserstream-mainnet-ewr.helius-rpc.com".to_string());
    let token = std::env::var("GRPC_TOKEN").unwrap_or_default();

    if token.is_empty() {
        eprintln!("⚠️  GRPC_TOKEN not set. Get your token at https://triton.one");
    }

    println!("Connecting to: {}", endpoint);

    let builder = GeyserGrpcClient::build_from_shared(endpoint.clone())?
        .x_token(Some(token.as_str()))?
        .max_decoding_message_size(64 * 1024 * 1024);

    // Enable TLS for HTTPS endpoints
    let mut client = if endpoint.starts_with("https://") {
        builder.tls_config(ClientTlsConfig::new().with_native_roots())?.connect()
    } else {
        builder.connect()
    }
    .await?;

    let version = client.get_version().await?;
    println!("✅ Connected to Triton gRPC, version: {:?}", version);
    println!("🔍 Listening for new pump.fun token launches...\n");

    let (mut subscribe_tx, mut stream) = client.subscribe().await?;

    let request = SubscribeRequest {
        slots: HashMap::new(),
        accounts: HashMap::new(),
        transactions: HashMap::from([(
            "pumpFun".to_string(),
            SubscribeRequestFilterTransactions {
                vote: Some(false),
                failed: Some(false),
                account_include: vec![],
                account_exclude: vec![],
                account_required: vec![
                    PUMP_PROGRAM_ID.to_string(),
                    PUMP_FUN_MINT_AUTHORITY.to_string(),
                ],
                ..Default::default()
            },
        )]),
        transactions_status: HashMap::new(),
        entry: HashMap::new(),
        blocks: HashMap::new(),
        blocks_meta: HashMap::new(),
        accounts_data_slice: vec![],
        commitment: Some(CommitmentLevel::Processed as i32),
        ..Default::default()
    };

    subscribe_tx.send(request).await?;
    println!("📡 Subscribed to pump.fun transactions (PROCESSED commitment)\n");

    let latency_samples: Arc<RwLock<Vec<i64>>> = Arc::new(RwLock::new(Vec::with_capacity(100)));

    while let Some(msg) = stream.next().await {
        let arrival_ms = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let update = match msg {
            Ok(u) => u,
            Err(e) => {
                eprintln!("Stream error: {e}");
                continue;
            }
        };

        // created_at: when gRPC server created the message (nanosecond precision)
        let created_at_ms = update.created_at.as_ref().map(|ts| {
            ts.seconds * 1000 + i64::from(ts.nanos) / 1_000_000
        });

        match &update.update_oneof {
            Some(UpdateOneof::Transaction(tx_update)) => {
                if let Some((mint, sig, slot)) = extract_mint_from_transaction(tx_update) {
                    print_mint_info(
                        &mint,
                        &sig,
                        slot,
                        arrival_ms,
                        created_at_ms,
                        &latency_samples,
                    )
                    .await;
                }
            }
            Some(UpdateOneof::Block(block)) => {
                for tx_info in &block.transactions {
                    if let Some((mint, sig, slot)) =
                        extract_mint_from_tx_info(tx_info, block.slot)
                    {
                        print_mint_info(
                            &mint,
                            &sig,
                            slot,
                            arrival_ms,
                            created_at_ms,
                            &latency_samples,
                        )
                        .await;
                    }
                }
            }
            _ => {}
        }
    }

    Ok(())
}
