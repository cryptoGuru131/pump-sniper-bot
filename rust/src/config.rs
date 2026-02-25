//! Config - env and trading params.

use anyhow::{Context, Result};
use solana_sdk::signature::Keypair;

pub const PUMP_PROGRAM_ID: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
pub const PUMP_FUN_MINT_AUTHORITY: &str = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";

const DEFAULT_GRPC_TRITON: &str = "https://api.rpcpool.com:443";
const DEFAULT_GRPC_HELIUS: &str = "https://laserstream-mainnet-ewr.helius-rpc.com";
const DEFAULT_RPC: &str = "https://api.mainnet-beta.solana.com";

#[derive(Clone)]
pub struct Config {
    pub grpc_endpoint: String,
    pub grpc_token: String,
    pub grpc_provider: Option<String>,
    pub rpc_url: String,
    pub buy_amount_sol: f64,
    pub slippage_bps: u64,
    pub trading_enabled: bool,
}

fn normalize_endpoint(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return DEFAULT_GRPC_HELIUS.to_string();
    }
    let mut url = s.to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        url = format!("https://{}", url);
    }
    if url.ends_with('/') {
        url.pop();
    }
    if !url.contains(":443") && !url.contains(':') {
        url.push_str(":443");
    }
    url
}

impl Config {
    pub fn from_env() -> Result<Self> {
        dotenvy::dotenv().ok();
        dotenvy::from_path(std::path::Path::new("../.env")).ok();

        let provider = std::env::var("GRPC_PROVIDER")
            .ok()
            .map(|s| s.to_lowercase());

        let (grpc_endpoint, grpc_token) = match provider.as_deref() {
            Some("triton") => (
                DEFAULT_GRPC_TRITON.to_string(),
                std::env::var("GRPC_TOKEN_TRITON")
                    .or_else(|_| std::env::var("GRPC_TOKEN"))
                    .unwrap_or_default(),
            ),
            Some("helius") => (
                DEFAULT_GRPC_HELIUS.to_string(),
                std::env::var("GRPC_TOKEN_HELIUS")
                    .or_else(|_| std::env::var("GRPC_TOKEN"))
                    .unwrap_or_default(),
            ),
            _ => {
                let endpoint = std::env::var("GRPC_ENDPOINT").unwrap_or_else(|_| DEFAULT_GRPC_HELIUS.to_string());
                let token = std::env::var("GRPC_TOKEN").unwrap_or_default();
                (normalize_endpoint(&endpoint), token)
            }
        };

        let rpc_url = std::env::var("RPC_URL").unwrap_or_else(|_| DEFAULT_RPC.to_string());
        let buy_amount_sol = std::env::var("BUY_AMOUNT_SOL")
            .unwrap_or_else(|_| "0.01".to_string())
            .parse()
            .unwrap_or(0.01);
        let slippage_bps = std::env::var("SLIPPAGE_BPS")
            .unwrap_or_else(|_| "500".to_string())
            .parse()
            .unwrap_or(500);
        let trading_enabled = std::env::var("TRADING_ENABLED").unwrap_or_else(|_| "true".to_string()) != "false";

        Ok(Self {
            grpc_endpoint,
            grpc_token,
            grpc_provider: provider,
            rpc_url,
            buy_amount_sol,
            slippage_bps,
            trading_enabled,
        })
    }

    pub fn get_keypair(&self) -> Result<Option<Keypair>> {
        let raw = std::env::var("PRIVATE_KEY").or_else(|_| std::env::var("KEYPAIR_PATH"));
        let raw = match raw {
            Ok(r) => r,
            Err(_) => return Ok(None),
        };

        if raw.len() > 50 && !raw.starts_with('[') {
            let bytes = bs58::decode(&raw)
                .into_vec()
                .context("Invalid base58 private key")?;
            let kp = Keypair::try_from(bytes.as_slice()).context("Keypair from bytes")?;
            Ok(Some(kp))
        } else {
            let data: Vec<u8> = if raw.starts_with('[') {
                serde_json::from_str(&raw).context("Parse keypair JSON")?
            } else {
                let path = std::path::Path::new(&raw);
                let contents = std::fs::read_to_string(path).context("Read keypair file")?;
                serde_json::from_str(&contents).context("Parse keypair JSON")?
            };
            let kp = Keypair::try_from(data.as_slice()).context("Keypair from bytes")?;
            Ok(Some(kp))
        }
    }
}
