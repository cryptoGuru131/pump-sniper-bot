//! Detector - pure sync mint extraction from Yellowstone updates.

use yellowstone_grpc_proto::geyser::subscribe_update::UpdateOneof;
use yellowstone_grpc_proto::geyser::SubscribeUpdate;
use yellowstone_grpc_proto::solana::storage::confirmed_block::{
    CompiledInstruction, InnerInstruction, Transaction, TransactionStatusMeta,
};

use crate::config::PUMP_FUN_MINT_AUTHORITY;

const CREATE_DISCRIMINATOR: [u8; 8] = [24, 30, 200, 40, 5, 28, 7, 119];
const CREATE_V2_DISCRIMINATOR: [u8; 8] = [214, 144, 76, 236, 95, 139, 49, 180];

#[derive(Debug, Clone)]
pub struct MintInfo {
    pub mint: String,
    pub slot: u64,
    /// True for create_v2 (Token-2022). Trader swaps token program when true.
    pub is_token_2022: bool,
    /// Block timestamp (epoch ms) when create tx was included. For latency: created_at → ws_receive.
    pub created_at_ms: Option<u64>,
}

fn get_account_keys(transaction: &Transaction, meta: Option<&TransactionStatusMeta>) -> Vec<Vec<u8>> {
    let msg = match &transaction.message {
        Some(m) => m,
        None => return vec![],
    };
    let mut keys = msg.account_keys.clone();
    if let Some(meta) = meta {
        keys.extend(meta.loaded_writable_addresses.iter().cloned());
        keys.extend(meta.loaded_readonly_addresses.iter().cloned());
    }
    keys
}

fn match_create_discriminator(data: &[u8]) -> Option<bool> {
    if data.len() < 8 {
        return None;
    }
    let disc = &data[0..8];
    if disc == CREATE_DISCRIMINATOR {
        Some(false)
    } else if disc == CREATE_V2_DISCRIMINATOR {
        Some(true)
    } else {
        None
    }
}

fn get_mint_from_instruction(
    instruction: &CompiledInstruction,
    account_keys: &[Vec<u8>],
) -> Option<String> {
    let idx = *instruction.accounts.first()? as usize;
    let key = account_keys.get(idx)?;
    if key.len() != 32 {
        return None;
    }
    let mint = bs58::encode(key).into_string();
    if mint == PUMP_FUN_MINT_AUTHORITY {
        return None;
    }
    Some(mint)
}

fn get_mint_from_inner_instruction(
    instruction: &InnerInstruction,
    account_keys: &[Vec<u8>],
) -> Option<String> {
    let idx = *instruction.accounts.first()? as usize;
    let key = account_keys.get(idx)?;
    if key.len() != 32 {
        return None;
    }
    let mint = bs58::encode(key).into_string();
    if mint == PUMP_FUN_MINT_AUTHORITY {
        return None;
    }
    Some(mint)
}

fn try_extract_mint(
    transaction: &Transaction,
    meta: Option<&TransactionStatusMeta>,
) -> Option<MintInfo> {
    let msg = transaction.message.as_ref()?;
    let account_keys = get_account_keys(transaction, meta);

    let check_compiled = |ix: &CompiledInstruction| {
        let is_v2 = match_create_discriminator(&ix.data)?;
        let mint = get_mint_from_instruction(ix, &account_keys)?;
        Some((mint, is_v2))
    };

    for ix in &msg.instructions {
        if let Some((mint, is_v2)) = check_compiled(ix) {
            return Some(MintInfo {
                mint,
                slot: 0,
                is_token_2022: is_v2,
                created_at_ms: None,
            });
        }
    }

    if let Some(meta) = meta {
        for inner in &meta.inner_instructions {
            for ix in &inner.instructions {
                if let Some(is_v2) = match_create_discriminator(&ix.data) {
                    if let Some(mint) = get_mint_from_inner_instruction(ix, &account_keys) {
                        return Some(MintInfo {
                            mint,
                            slot: 0,
                            is_token_2022: is_v2,
                            created_at_ms: None,
                        });
                    }
                }
            }
        }
    }

    None
}

/// Extract mint from Yellowstone SubscribeUpdate. Sync, no I/O.
pub fn get_mint_from_update(update: &SubscribeUpdate) -> Option<MintInfo> {
    let UpdateOneof::Transaction(tx_update) = update.update_oneof.as_ref()? else {
        return None;
    };

    let tx_info = tx_update.transaction.as_ref()?;
    if tx_info.meta.as_ref().and_then(|m| m.err.as_ref()).is_some() {
        return None;
    }

    let transaction = tx_info.transaction.as_ref()?;
    let slot = tx_update.slot;

    let mut info = try_extract_mint(transaction, tx_info.meta.as_ref())?;
    info.slot = slot;
    info.created_at_ms = update.created_at.as_ref().map(|ts| {
        (ts.seconds as u64) * 1000 + (ts.nanos as u64) / 1_000_000
    });
    Some(info)
}
