//! Trader - buy execution using pumpfun crate.
//! Supports both legacy SPL Token and Token-2022 (create_v2) by replacing ATA and buy instructions.

use pumpfun::common::types::{Cluster, PriorityFee};
use pumpfun::constants::accounts;
use pumpfun::utils::transaction::get_transaction;
use pumpfun::PumpFun;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::Signer,
};
use spl_associated_token_account::{
    get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use crate::config::Config;
use crate::detector::MintInfo;

/// Latency report for analysis: created_at → ws_receive → get_tx → tx_sent → tx_confirmed.
#[derive(Debug, Clone)]
pub struct LatencyReport {
    pub mint: String,
    pub created_at_ms: Option<u64>,
    pub ws_receive_ms: u64,
    pub get_tx_ms: u64,
    pub tx_sent_ms: u64,
    pub tx_confirmed_ms: Option<u64>,
    pub success: bool,
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

const DEDUPE_MS: u64 = 5000;
const BONDING_CURVE_POLL_MS: u64 = 40;
const BONDING_CURVE_MAX_RETRIES: u32 = 12;
const TOKEN_2022_PROGRAM_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/// Convert instructions for Token-2022: replace create ATA with Token-2022 ATA, fix buy instruction ATAs and token program.
fn convert_instructions_for_token_2022(
    instructions: Vec<Instruction>,
    payer: &Pubkey,
    mint: &Pubkey,
    token_2022: &Pubkey,
) -> Vec<Instruction> {
    let bonding_curve = match PumpFun::get_bonding_curve_pda(mint) {
        Some(bc) => bc,
        None => return instructions,
    };
    let bonding_curve_ata =
        get_associated_token_address_with_program_id(&bonding_curve, mint, token_2022);
    let buyer_ata = get_associated_token_address_with_program_id(payer, mint, token_2022);

    instructions
        .into_iter()
        .map(|ix| {
            // Create ATA instruction: replace entirely with Token-2022 version
            if ix.program_id == spl_associated_token_account::ID {
                create_associated_token_account_idempotent(payer, payer, mint, token_2022)
            }
            // Buy instruction: replace bonding curve ATA, buyer ATA, and token program
            else if ix.program_id == accounts::PUMPFUN {
                let new_accounts: Vec<AccountMeta> = ix
                    .accounts
                    .iter()
                    .enumerate()
                    .map(|(i, meta)| {
                        if i == 4 {
                            AccountMeta::new(bonding_curve_ata, meta.is_signer)
                        } else if i == 5 {
                            AccountMeta::new(buyer_ata, meta.is_signer)
                        } else if meta.pubkey == accounts::TOKEN_PROGRAM {
                            AccountMeta::new_readonly(*token_2022, meta.is_signer)
                        } else {
                            meta.clone()
                        }
                    })
                    .collect();
                Instruction {
                    program_id: ix.program_id,
                    accounts: new_accounts,
                    data: ix.data,
                }
            } else {
                ix
            }
        })
        .collect()
}

pub struct Trader {
    client: pumpfun::PumpFun,
    recent_mints: std::sync::Mutex<std::collections::HashSet<String>>,
    last_dedupe_clean: std::sync::Mutex<std::time::Instant>,
    config: Config,
}

impl Trader {
    pub fn from_config(config: &Config) -> Self {
        let keypair = config.get_keypair().ok().flatten().expect("keypair");
        let payer = Arc::new(keypair);

        let commitment = CommitmentConfig::confirmed();
        let priority_fee = PriorityFee::default();
        let rpc_url = config.rpc_url.clone();
        let ws_url = rpc_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        let cluster = Cluster::new(rpc_url, ws_url, commitment, priority_fee);
        let client = pumpfun::PumpFun::new(payer, cluster);

        Self {
            client,
            recent_mints: std::sync::Mutex::new(std::collections::HashSet::new()),
            last_dedupe_clean: std::sync::Mutex::new(std::time::Instant::now()),
            config: config.clone(),
        }
    }

    pub async fn init(config: &Config) -> bool {
        config.get_keypair().ok().flatten().is_some() && config.trading_enabled
    }

    /// Execute buy and return latency report for analysis.
    pub async fn execute_buy(&self, mint_info: &MintInfo, ws_receive_ms: u64) -> Option<LatencyReport> {
        if !self.config.trading_enabled {
            return None;
        }

        let mint_address = &mint_info.mint;
        let is_token_2022 = mint_info.is_token_2022;

        let now = std::time::Instant::now();
        {
            let mut last = self.last_dedupe_clean.lock().unwrap();
            if now.duration_since(*last).as_millis() > DEDUPE_MS as u128 {
                self.recent_mints.lock().unwrap().clear();
                *last = now;
            }
        }
        {
            let mut mints = self.recent_mints.lock().unwrap();
            if mints.contains(mint_address) {
                return None;
            }
            mints.insert(mint_address.clone());
        }

        let mint = match Pubkey::from_str(mint_address) {
            Ok(p) => p,
            Err(_) => {
                eprintln!("❌ Invalid mint: {}", mint_address);
                return None;
            }
        };

        let sol_lamports = (self.config.buy_amount_sol * 1_000_000_000.0) as u64;
        let slippage_bps = Some(self.config.slippage_bps);
        let track_volume = Some(true);

        // Wait for bonding curve to exist so pumpfun uses correct creator (not payer).
        // When bonding curve is missing, pumpfun uses payer as creator → ConstraintSeeds on creator_vault.
        let bonding_curve_pda = match PumpFun::get_bonding_curve_pda(&mint) {
            Some(pda) => pda,
            None => {
                eprintln!("❌ Buy failed ({}): bonding curve PDA not found", mint_address);
                return None;
            }
        };
        for attempt in 0..BONDING_CURVE_MAX_RETRIES {
            if self.client.rpc.get_account(&bonding_curve_pda).await.is_ok() {
                break;
            }
            if attempt == BONDING_CURVE_MAX_RETRIES - 1 {
                eprintln!("⚠️ {} bonding curve not found after {}ms, proceeding anyway", mint_address, BONDING_CURVE_POLL_MS * BONDING_CURVE_MAX_RETRIES as u64);
            }
            tokio::time::sleep(Duration::from_millis(BONDING_CURVE_POLL_MS)).await;
        }

        let mut instructions = pumpfun::PumpFun::get_priority_fee_instructions(
            &self.client.cluster.priority_fee,
        );

        let mut buy_ix = match self
            .client
            .get_buy_instructions(mint, sol_lamports, track_volume, slippage_bps)
            .await
        {
            Ok(ix) => ix,
            Err(e) => {
                eprintln!("❌ Buy failed ({}): get_buy_instructions: {}", mint_address, e);
                return None;
            }
        };

        if is_token_2022 {
            let token_2022 = Pubkey::from_str(TOKEN_2022_PROGRAM_ID).unwrap();
            let payer_pubkey = self.client.payer.pubkey();
            buy_ix = convert_instructions_for_token_2022(buy_ix, &payer_pubkey, &mint, &token_2022);
        }

        instructions.extend(buy_ix);

        let tx = match get_transaction(
            self.client.rpc.clone(),
            self.client.payer.clone(),
            &instructions,
            None,
        )
        .await
        {
            Ok(tx) => tx,
            Err(e) => {
                eprintln!("❌ Buy failed ({}): get_transaction: {}", mint_address, e);
                return None;
            }
        };
        let get_tx_ms = epoch_ms();

        let sig = match self.client.rpc.send_transaction(&tx).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("❌ Buy tx failed ({}): send: {}", mint_address, e);
                return Some(LatencyReport {
                    mint: mint_address.clone(),
                    created_at_ms: mint_info.created_at_ms,
                    ws_receive_ms,
                    get_tx_ms,
                    tx_sent_ms: get_tx_ms,
                    tx_confirmed_ms: None,
                    success: false,
                });
            }
        };
        let tx_sent_ms = epoch_ms();

        let (tx_confirmed_ms, success) = loop {
            match self.client.rpc.get_signature_status(&sig).await {
                Ok(Some(Ok(_))) => break (Some(epoch_ms()), true),
                Ok(Some(Err(_))) => break (Some(epoch_ms()), false),
                _ => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        };

        let report = LatencyReport {
            mint: mint_address.clone(),
            created_at_ms: mint_info.created_at_ms,
            ws_receive_ms,
            get_tx_ms,
            tx_sent_ms,
            tx_confirmed_ms,
            success,
        };

        if success {
            println!("🟢 BUY SENT {} | {}", mint_address, sig);
        } else {
            eprintln!("❌ Buy tx failed ({}): {}", mint_address, sig);
        }

        Some(report)
    }
}
