/**
 * Yellowstone gRPC client and subscription management.
 * @module services/grpc
 */

import Client, { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import { config } from "../config/index.js";
import { PUMP_PROGRAM_ID } from "../core/constants.js";

const Commitment = CommitmentLevel?.PROCESSED ?? 0;

/**
 * Create and connect gRPC client.
 * @returns {Promise<{ client: object, stream: object }>}
 */
export async function createGrpcClient() {
  const client = new Client(config.grpc.endpoint, config.grpc.token, {
    grpcMaxDecodingMessageSize: 64 * 1024 * 1024,
  });

  await client.connect();
  const version = await client.getVersion();

  const stream = await client.subscribe();

  const { created, migrated, copyTrade } = config.modes;
  const copyWallet = config.copyTradeWallet;
  const transactions = {};
  if (created || migrated) {
    transactions.pumpFun = {
      vote: false,
      failed: false,
      accountInclude: [],
      accountExclude: [],
      accountRequired: [PUMP_PROGRAM_ID],
    };
  }
  if (copyTrade && copyWallet) {
    transactions.copyTrade = {
      vote: false,
      failed: false,
      accountInclude: [copyWallet],
      accountExclude: [],
      accountRequired: [PUMP_PROGRAM_ID],
    };
  }
  if (Object.keys(transactions).length === 0) {
    transactions.pumpFun = {
      vote: false,
      failed: false,
      accountInclude: [],
      accountExclude: [],
      accountRequired: [PUMP_PROGRAM_ID],
    };
  }

  const request = {
    slots: { slots: {} },
    accounts: {},
    transactions,
    transactionsStatus: {},
    entry: {},
    blocks: {},
    blocksMeta: {},
    accountsDataSlice: [],
    commitment: Commitment,
  };

  await new Promise((resolve, reject) => {
    stream.write(request, (err) => (err ? reject(err) : resolve()));
  });

  return { client, stream, version };
}

/**
 * Start ping keepalive on stream.
 * @param {object} stream
 * @param {number} [intervalMs=30000]
 */
export function startPingKeepalive(stream, intervalMs = 30000) {
  return setInterval(() => {
    stream.write(
      {
        ping: { id: 1 },
        accounts: {},
        accountsDataSlice: [],
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        slots: {},
      },
      (err) => err && console.error("Ping error:", err)
    );
  }, intervalMs);
}
