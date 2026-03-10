# Pump.fun Sniper

Low-latency new token detection + auto-buy + migration alerts using **Yellowstone gRPC** and **@pump-fun/pump-sdk**.

## Features

- **New token detection** – create/create_v2 instructions via gRPC (PROCESSED commitment)
- **Migration detection** – bonding curve → PumpSwap/Raydium migrations
- **Auto-buy** – fire-and-forget buy on new token detection
- **Optional auto-sell** – sell after configurable delay
- **Token-2022** – full support for create_v2 and Token-2022 mints

## Requirements

- **Node.js 18+**
- Triton or Helius gRPC token
- Solana RPC endpoint
- Wallet private key

## Quick Start

```bash
# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your GRPC_TOKEN, RPC_URL, PRIVATE_KEY

# Run
npm start
```

## Project Structure

```
pump-sniper-bot/
├── src/
│   ├── index.js           # Entry point
│   ├── config/            # Configuration
│   │   └── index.js
│   ├── core/              # Constants
│   │   └── constants.js
│   ├── detectors/         # Event detection
│   │   ├── index.js
│   │   ├── create.js      # New token (create/create_v2)
│   │   ├── migrate.js     # Migration events
│   │   └── utils.js
│   └── services/         # External integrations
│       ├── grpc.js                  # Yellowstone gRPC client
│       ├── pumpFunBuySellEngine.js  # Bonding curve buy/sell
│       ├── pumpSwapBuySellEngine.js # PumpSwap buy/sell (migrated)
│       └── index.js
├── rust/                  # Rust port
├── .env.example
├── .nvmrc
├── eslint.config.js
├── .prettierrc
└── package.json
```

## Configuration

| Variable | Description |
|----------|-------------|
| `GRPC_PROVIDER` | `triton` \| `helius` |
| `GRPC_TOKEN_TRITON` | Triton gRPC token |
| `GRPC_TOKEN_HELIUS` | Helius gRPC token |
| `RPC_URL` | Solana RPC for transactions |
| `PRIVATE_KEY` | Base58 private key or path to keypair JSON |
| `BUY_AMOUNT_SOL` | SOL per buy (default: 0.01) |
| `SLIPPAGE_BPS` | Slippage in basis points (default: 5000) |
| `TRADING_ENABLED` | `true` \| `false` |
| `AUTO_SELL_ENABLED` | Auto-sell after buy |
| `AUTO_SELL_DELAY_MS` | Delay before sell (default: 10000) |
| `TOKEN_FILTER_ADDRESS_SUFFIX` | Only tokens whose mint ends with this |

## Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Run sniper |
| `npm run dev` | Run with nodemon |
| `npm run fetch` | Detection only (no trading) |
| `npm run lint` | Run ESLint |
| `npm run format` | Format with Prettier |

## Latency Optimizations

- gRPC PROCESSED commitment (~400ms faster than WebSockets)
- Pre-fetched global state at startup
- Local-only buy (no bonding curve RPC before buy)
- Blockhash reuse from create tx
- `skipPreflight: true`
- Mint deduplication

## Output

```
🪙 7xKX... | slot 284521034 | https://pump.fun/7xKX...
🟢 BUY SENT 7xKX... | 5abc...
🚀 MIGRATED 9yAb... | slot 284521089 | https://pump.fun/9yAb...
```

## Rust Version

A Rust port lives in `rust/`:

```bash
cd rust && cargo run --release
```

Uses the same `.env`. See [rust/README.md](rust/README.md).

## License

MIT
