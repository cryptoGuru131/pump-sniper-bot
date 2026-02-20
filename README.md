# Pump.fun New Coin Sniper

Fetches new pump.fun token launches in real-time using **Triton Dragon's Mouth gRPC**.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create `.env` from the example:
   ```bash
   cp .env.example .env
   ```

3. Add your Triton gRPC token to `.env`:
   ```
   GRPC_TOKEN=your_token_here
   ```

## Run

```bash
npm start
```

New tokens will be logged as they are created on-chain. Uses `PROCESSED` commitment for the fastest possible detection (intra-slot updates, ~400ms faster than WebSockets).

## Output

```
🪙 NEW TOKEN DETECTED
   Mint: 7xKX...
   Slot: 284521034
   Pump.fun: https://pump.fun/7xKX...
```

## Integration

The script emits new mints as they're detected. To add buy logic, extend the handler in `stream.on("data", ...)` — you'll have the mint and slot for same-block execution.
