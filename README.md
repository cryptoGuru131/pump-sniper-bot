# Pump.fun Sniper

Low-latency new token detection + auto-buy using **Triton Yellowstone gRPC** and **@pump-fun/pump-sdk**.

## Requirements

- **Node.js 18+** (required by dependencies)
- Triton gRPC token
- Solana RPC endpoint
- Wallet private key

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and configure:
   ```bash
   cp .env.example .env
   ```

3. Required env vars:
   ```
   GRPC_ENDPOINT=https://api.rpcpool.com:443
   GRPC_TOKEN=your-triton-grpc-token
   RPC_URL=https://your-rpc.com/token
   PRIVATE_KEY=your-base58-private-key
   BUY_AMOUNT_SOL=0.01
   SLIPPAGE_BPS=100
   ```

## Run

```bash
npm start
# or with auto-reload:
npm run dev
```

- **Detection**: Uses PROCESSED commitment for earliest possible detection (~400ms faster than WebSockets)
- **Buy**: Automatically sends buy tx when new token is detected
- **Latency**: Pre-fetches global/feeConfig at startup; fire-and-forget buy; skipPreflight

## Rust version

A Rust port lives in `rust/`:

```bash
cd rust && cargo run --release
```

Uses the same `.env`. See [rust/README.md](rust/README.md) for details.

## Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Run sniper (detect + buy) |
| `npm run dev` | Run with nodemon |
| `npm run fetch` | Detection only (TRADING_ENABLED=false) |

## Latency optimizations

- gRPC PROCESSED commitment
- Pre-fetched global and feeConfig at startup
- Fire-and-forget buy (no await in hot path)
- `skipPreflight: true` for tx send
- Mint deduplication
- Minimal logging in hot path

## Output

```
🪙 7xKX... | slot 284521034 | gRPC 45ms (avg 52) | https://pump.fun/7xKX...
🟢 BUY SENT 7xKX... | 5abc... | 120ms
```
