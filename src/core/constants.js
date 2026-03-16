/**
 * Pump.fun program and instruction constants.
 * @module core/constants
 */

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export const PUMP_FUN_MINT_AUTHORITY = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";

/** Instruction discriminators (first 8 bytes of instruction data) */
export const CREATE_DISCRIMINATOR = new Uint8Array([24, 30, 200, 40, 5, 28, 7, 119]);
export const CREATE_V2_DISCRIMINATOR = new Uint8Array([214, 144, 76, 236, 95, 139, 49, 180]);
export const MIGRATE_DISCRIMINATOR = new Uint8Array([155, 234, 231, 146, 236, 158, 162, 30]);
export const BUY_DISCRIMINATOR = new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]);
export const BUY_EXACT_SOL_IN_DISCRIMINATOR = new Uint8Array([56, 252, 116, 8, 158, 223, 205, 95]);
export const SELL_DISCRIMINATOR = new Uint8Array([51, 230, 133, 164, 1, 127, 131, 173]);

/** PumpSwap AMM program (migrated tokens) */
export const PUMP_AMM_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
