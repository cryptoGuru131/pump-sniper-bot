# Pump Sniper (Rust)

Low-latency Pump.fun token launch detector using Triton Yellowstone gRPC.

## Why Rust?

- **Lower latency** – No V8/Node overhead; direct gRPC streaming
- **Faster parsing** – Native protobuf decoding
- **Lower memory** – No GC pauses

## Setup

1. Copy `.env` from project root (or create one with `GRPC_ENDPOINT` and `GRPC_TOKEN`)
2. Get your Triton token at https://triton.one

## Build & Run

```bash
cd rust
cargo build --release
./target/release/pump-sniper
```

Or run directly:

```bash
cargo run --release
```

## Environment

| Variable       | Description                          |
|----------------|--------------------------------------|
| `GRPC_ENDPOINT`| Triton gRPC endpoint (default: `https://api.rpcpool.com:443`) |
| `GRPC_TOKEN`   | Your Triton API token                |

## Latency Tips

- Use the endpoint from your [Triton portal](https://customers.triton.one) (GeoDNS routes to nearest region)
- Deploy in the same region as Solana validators (e.g. AWS us-east-1)
- Triton targets ≤50ms when your server has ≤50ms RTT to the endpoint
