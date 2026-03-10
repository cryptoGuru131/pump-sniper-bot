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
