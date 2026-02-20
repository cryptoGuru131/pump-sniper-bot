//! Pump.fun Token Creation Detector via Yellowstone gRPC
//!
//! Detects token creation transactions at **Processed** commitment level -
//! the earliest possible stage, before confirmation. This enables buying
//! in the same block as token creation.
//!
//! Uses the Pump.fun `create` instruction discriminator:
//! [24, 30, 200, 40, 5, 28, 7, 119]
//!
//! Account order for create instruction (from Pump.fun IDL):
//! 0: mint, 1: mintAuthority, 2: bondingCurve, 3: associatedBondingCurve,
//! 4: global, 5: mplTokenMetadata, 6: metadata, 7: user (creator), ...

use {
    bs58,
    futures::{sink::SinkExt, stream::StreamExt},
    log::{error, info, warn},
    std::{collections::HashMap, env, fmt},
    tokio,
    tonic::{service::Interceptor, transport::ClientTlsConfig, Status},
    yellowstone_grpc_client::GeyserGrpcClient,
    yellowstone_grpc_proto::{
        geyser::SubscribeUpdate,
        prelude::{
            CommitmentLevel, SubscribeRequest, SubscribeRequestFilterTransactions,
            subscribe_update::UpdateOneof,
        },
    },
};

// --- Constants ---

const RUST_LOG_LEVEL: &str = "info";

/// Pump.fun program ID
const PUMP_FUN_PROGRAM: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/// 8-byte Anchor discriminator for Pump.fun `create` instruction
/// SHA256("global:create")[0..8]
const PUMP_FUN_CREATE_DISCRIMINATOR: [u8; 8] = [24, 30, 200, 40, 5, 28, 7, 119];

// Replace with your QuickNode Yellowstone gRPC endpoint
const ENDPOINT: &str = "https://multi-indulgent-sun.solana-mainnet.quiknode.pro/9d834ba1d89476052f0892df2cca9ccfbd661693/";
const AUTH_TOKEN: &str = "qnsec_YzgyZmU4ZWYtMmQ4YS00ODk2LThiOTAtYjM4MzY4N2VhZDgz";

// --- Data structures ---

/// Parsed token creation event - emitted as soon as create tx is processed
#[derive(Debug, Clone)]
pub struct TokenCreation {
    pub signature: String,
    pub slot: u64,
    pub mint: String,
    pub creator: String,
    pub bonding_curve: String,
    pub success: bool,
}

impl fmt::Display for TokenCreation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "🪙 PUMP.FUN TOKEN CREATED (Processed - pre-confirmation)")?;
        writeln!(f, "  Signature: {}", self.signature)?;
        writeln!(f, "  Slot: {}", self.slot)?;
        writeln!(f, "  Mint: {}", self.mint)?;
        writeln!(f, "  Creator: {}", self.creator)?;
        writeln!(f, "  Bonding Curve: {}", self.bonding_curve)?;
        writeln!(f, "  Success: {}", self.success)?;
        Ok(())
    }
}

#[derive(Debug, Default)]
struct ParsedTransaction {
    signature: String,
    account_keys: Vec<String>,
    instructions: Vec<ParsedInstruction>,
    inner_instructions: Vec<ParsedInnerInstruction>,
    success: bool,
    slot: u64,
}

#[derive(Debug)]
struct ParsedInstruction {
    program_id: String,
    program_id_index: u8,
    accounts: Vec<(usize, String)>,
    data: Vec<u8>,
}

#[derive(Debug)]
struct ParsedInnerInstruction {
    instruction_index: u8,
    instructions: Vec<ParsedInstruction>,
}

// --- Main ---

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    setup_logging();
    info!("Starting Pump.fun token creation monitor (Processed commitment)");
    info!("Program: {}", PUMP_FUN_PROGRAM);

    let mut client = setup_client().await?;
    info!("Connected to gRPC endpoint");

    let (subscribe_tx, subscribe_rx) = client.subscribe().await?;
    send_subscription_request(subscribe_tx).await?;
    info!("Subscription active. Detecting token creation as soon as executed...");

    process_updates(subscribe_rx).await?;
    info!("Stream closed");
    Ok(())
}

fn setup_logging() {
    unsafe {
        env::set_var("RUST_LOG", RUST_LOG_LEVEL);
    }
    env_logger::init();
}

async fn setup_client(
) -> Result<GeyserGrpcClient<impl Interceptor>, Box<dyn std::error::Error>> {
    info!("Connecting to gRPC endpoint: {}", ENDPOINT);
    let client = GeyserGrpcClient::build_from_shared(ENDPOINT.to_string())?
        .x_token(Some(AUTH_TOKEN.to_string()))?
        .tls_config(ClientTlsConfig::new().with_native_roots())?
        .connect()
        .await?;
    Ok(client)
}

async fn send_subscription_request<T>(mut tx: T) -> Result<(), Box<dyn std::error::Error>>
where
    T: SinkExt<SubscribeRequest> + Unpin,
    <T as futures::Sink<SubscribeRequest>>::Error: std::error::Error + 'static,
{
    let mut accounts_filter = HashMap::new();
    accounts_filter.insert(
        "pumpfun_monitor".to_string(),
        SubscribeRequestFilterTransactions {
            account_include: vec![],
            account_exclude: vec![],
            account_required: vec![PUMP_FUN_PROGRAM.to_string()],
            vote: Some(false),
            failed: Some(false),
            signature: None,
        },
    );

    // Processed = earliest possible; transaction just executed, not yet confirmed
    tx.send(SubscribeRequest {
        transactions: accounts_filter,
        commitment: Some(CommitmentLevel::Processed as i32),
        ..Default::default()
    })
    .await?;
    Ok(())
}

async fn process_updates<S>(mut stream: S) -> Result<(), Box<dyn std::error::Error>>
where
    S: StreamExt<Item = Result<SubscribeUpdate, Status>> + Unpin,
{
    while let Some(message) = stream.next().await {
        match message {
            Ok(msg) => handle_message(msg)?,
            Err(e) => {
                error!("Error receiving message: {:?}", e);
                break;
            }
        }
    }
    Ok(())
}

fn handle_message(msg: SubscribeUpdate) -> Result<(), Box<dyn std::error::Error>> {
    match msg.update_oneof {
        Some(UpdateOneof::Transaction(tx_update)) => {
            match parse_and_detect_create(&tx_update) {
                Some(creation) => {
                    info!("{}", creation);
                    // TODO: Trigger buy logic here - you have mint, bonding_curve, slot
                    // Submit buy tx targeting same slot for same-block execution
                }
                None => {}
            }
        }
        Some(UpdateOneof::Ping(_)) => {
            // Keep-alive ping, ignore
        }
        _ => {}
    }
    Ok(())
}

/// Parse transaction and detect Pump.fun create instruction.
/// Returns TokenCreation if found (in top-level or inner instructions).
fn parse_and_detect_create(
    tx_update: &yellowstone_grpc_proto::geyser::SubscribeUpdateTransaction,
) -> Option<TokenCreation> {
    let parsed = parse_transaction(tx_update).ok()?;

    // Check top-level instructions
    for ix in &parsed.instructions {
        if let Some(creation) = extract_create_from_instruction(ix, &parsed) {
            return Some(creation);
        }
    }

    // Check inner instructions (create can be CPI'd)
    for inner in &parsed.inner_instructions {
        for ix in &inner.instructions {
            if let Some(creation) = extract_create_from_instruction(ix, &parsed) {
                return Some(creation);
            }
        }
    }

    None
}

fn extract_create_from_instruction(
    ix: &ParsedInstruction,
    parsed: &ParsedTransaction,
) -> Option<TokenCreation> {
    if ix.program_id != PUMP_FUN_PROGRAM {
        return None;
    }
    if ix.data.len() < 8 {
        return None;
    }
    if ix.data[0..8] != PUMP_FUN_CREATE_DISCRIMINATOR {
        return None;
    }

    // Create instruction accounts (from Pump.fun IDL):
    // 0: mint, 1: mintAuthority, 2: bondingCurve, 3: associatedBondingCurve,
    // 4: global, 5: mplTokenMetadata, 6: metadata, 7: user (creator)
    if ix.accounts.len() < 8 {
        warn!(
            "Create instruction with insufficient accounts: {}",
            ix.accounts.len()
        );
        return None;
    }

    let mint = ix.accounts.get(0).map(|(_, a)| a.clone())?;
    let bonding_curve = ix.accounts.get(2).map(|(_, a)| a.clone())?;
    let user = ix.accounts.get(7).map(|(_, a)| a.clone())?;

    Some(TokenCreation {
        signature: parsed.signature.clone(),
        slot: parsed.slot,
        mint,
        creator: user,
        bonding_curve,
        success: parsed.success,
    })
}

fn parse_transaction(
    tx_update: &yellowstone_grpc_proto::geyser::SubscribeUpdateTransaction,
) -> Result<ParsedTransaction, Box<dyn std::error::Error>> {
    let mut parsed = ParsedTransaction::default();
    parsed.slot = tx_update.slot;

    let tx_info = tx_update
        .transaction
        .as_ref()
        .ok_or("Missing transaction")?;

    parsed.signature = bs58::encode(&tx_info.signature).into_string();

    if let Some(tx) = &tx_info.transaction {
        if let Some(msg) = &tx.message {
            for key in &msg.account_keys {
                parsed.account_keys.push(bs58::encode(key).into_string());
            }
            if let Some(meta) = &tx_info.meta {
                for addr in &meta.loaded_writable_addresses {
                    parsed
                        .account_keys
                        .push(bs58::encode(addr).into_string());
                }
                for addr in &meta.loaded_readonly_addresses {
                    parsed
                        .account_keys
                        .push(bs58::encode(addr).into_string());
                }
            }

            for ix in &msg.instructions {
                let program_id_index = ix.program_id_index;
                let program_id = if (program_id_index as usize) < parsed.account_keys.len() {
                    parsed.account_keys[program_id_index as usize].clone()
                } else {
                    "unknown".to_string()
                };
                let mut accounts = Vec::new();
                for &acc_idx in &ix.accounts {
                    let idx = acc_idx as usize;
                    if idx < parsed.account_keys.len() {
                        accounts.push((idx, parsed.account_keys[idx].clone()));
                    }
                }
                parsed.instructions.push(ParsedInstruction {
                    program_id,
                    program_id_index: program_id_index as u8,
                    accounts,
                    data: ix.data.clone(),
                });
            }
        }
    }

    if let Some(meta) = &tx_info.meta {
        parsed.success = meta.err.is_none();
        for inner_ix in &meta.inner_instructions {
            let mut parsed_inner = Vec::new();
            for ix in &inner_ix.instructions {
                let program_id_index = ix.program_id_index;
                let program_id =
                    if (program_id_index as usize) < parsed.account_keys.len() {
                        parsed.account_keys[program_id_index as usize].clone()
                    } else {
                        "unknown".to_string()
                    };
                let mut accounts = Vec::new();
                for &acc_idx in &ix.accounts {
                    let idx = acc_idx as usize;
                    if idx < parsed.account_keys.len() {
                        accounts.push((idx, parsed.account_keys[idx].clone()));
                    }
                }
                parsed_inner.push(ParsedInstruction {
                    program_id,
                    program_id_index: program_id_index as u8,
                    accounts,
                    data: ix.data.clone(),
                });
            }
            parsed.inner_instructions.push(ParsedInnerInstruction {
                instruction_index: inner_ix.index as u8,
                instructions: parsed_inner,
            });
        }
    }

    Ok(parsed)
}
