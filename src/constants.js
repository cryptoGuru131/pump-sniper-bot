/**
 * Pump.fun program and instruction constants
 */
export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export const PUMP_FUN_MINT_AUTHORITY = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";

// Instruction discriminators (first 8 bytes of instruction data)
// create: "Creates a new coin and bonding curve"
export const CREATE_DISCRIMINATOR = new Uint8Array([24, 30, 200, 40, 5, 28, 7, 119]);
// create_v2: "Creates a new spl-22 coin and bonding curve"
export const CREATE_V2_DISCRIMINATOR = new Uint8Array([214, 144, 76, 236, 95, 139, 49, 180]);
