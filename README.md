# Laserstream – Pump.fun Token Creation Detector

Detects **Pump.fun token creation** via **Yellowstone Geyser gRPC** at the **Processed** commitment level—the earliest possible stage, before confirmation. This enables buying in the same block as token creation.

## How It Works

1. **Subscribe** to transactions that touch the Pump.fun program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`)
2. **Filter** by the `create` instruction discriminator: `[24, 30, 200, 40, 5, 28, 7, 119]`
3. **Parse** mint, bonding curve, and creator from instruction accounts
4. **Emit** a `TokenCreation` event as soon as the transaction is processed (before confirmed/finalized)

## Commitment Level: Processed

- **Processed** – Fastest; transaction has been executed by the node but can still be rolled back
- **Confirmed** – Supermajority vote received
- **Finalized** – Cannot be rolled back

Using `Processed` gives the lowest latency so you can react and submit a buy in the same block.

## Prerequisites

- [Rust](https://rustup.rs/) (1.70+)
- [QuickNode](https://www.quicknode.com/) account with [Yellowstone Geyser gRPC](https://marketplace.quicknode.com/add-on/yellowstone-grpc-geyser-plugin) add-on

## Configuration

Edit `src/main.rs`:

```rust
const ENDPOINT: &str = "https://your-quicknode-endpoint.grpc.solana-mainnet.quiknode.pro:10000";
const AUTH_TOKEN: &str = "your-auth-token";
```

Or use environment variables (add support as needed):

- `YELLOWSTONE_GRPC_ENDPOINT`
- `YELLOWSTONE_GRPC_TOKEN`

## Build & Run

```bash
cargo build --release
cargo run --release
```

## Output

When a token is created, you'll see:

```
🪙 PUMP.FUN TOKEN CREATED (Processed - pre-confirmation)
  Signature: 5abc...
  Slot: 123456789
  Mint: 7xKX...
  Creator: 9yLZ...
  Bonding Curve: EsmV...
  Success: true
```

## Next Steps: Same-Block Buy

To buy in the same block:

1. On `TokenCreation`, build a Pump.fun `buy` instruction
2. Submit the buy transaction with the **same slot** or immediately after
3. Consider co-location (e.g. validator region) and private RPC for minimal latency
4. Use `sendTransaction` with `skipPreflight` and appropriate `maxRetries` for speed

## Pump.fun Create Instruction (IDL)

| Index | Account              |
|-------|----------------------|
| 0     | mint (Signer)        |
| 1     | mintAuthority        |
| 2     | bondingCurve         |
| 3     | associatedBondingCurve |
| 4     | global               |
| 5     | mplTokenMetadata     |
| 6     | metadata             |
| 7     | user (creator, Signer) |

## References

- [QuickNode Yellowstone gRPC Guide](https://www.quicknode.com/guides/solana-development/tooling/geyser/yellowstone-rust)
- [Pump.fun Create Discriminator](https://allenhark.com/blog/pumpfun-create-instruction-discriminator)
- [Pump.fun Program Docs](https://github.com/pump-fun/pump-public-docs)
