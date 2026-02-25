# Pump Sniper (Rust)

Rust port of the pump-sniper-bot. Low-latency new token detection via Yellowstone gRPC + buy execution via [pumpfun](https://docs.rs/pumpfun) crate.

## Requirements

- Rust 1.70+
- `.env` in project root (same format as Node.js version)

## Build

```bash
cd rust
cargo build --release
```

## Run

```bash
cd rust
cargo run --release
```

Or from project root:

```bash
./rust/target/release/pump-sniper
```

## Configuration

Uses the same `.env` as the Node.js version:

- `GRPC_PROVIDER` – `triton` | `helius` | custom
- `GRPC_TOKEN` / `GRPC_TOKEN_TRITON` / `GRPC_TOKEN_HELIUS`
- `GRPC_ENDPOINT` – custom gRPC endpoint
- `RPC_URL` – Solana RPC for sending transactions
- `PRIVATE_KEY` – base58 private key or path to keypair JSON
- `BUY_AMOUNT_SOL` – SOL amount per buy (default: 0.01)
- `SLIPPAGE_BPS` – slippage in basis points (default: 100 = 1%)
- `TRADING_ENABLED` – `true` | `false`

## Architecture

- **config** – Env loading, keypair, provider selection
- **detector** – Mint extraction from gRPC `SubscribeUpdate` (create/create_v2 discriminators)
- **trader** – Buy via pumpfun crate, dedupe, retries
- **main** – gRPC subscribe loop, PROCESSED commitment, ping keepalive

## Token-2022 (create_v2) support

Both legacy `create` and `create_v2` (Token-2022) tokens are detected and bought. For Token-2022 mints, the trader swaps the token program from legacy to `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` in all buy instructions before sending.
