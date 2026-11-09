import { StrKey } from '@stellar/stellar-sdk';

/**
 * A classic Stellar account address (G..., 56 chars, valid checksum). Muxed
 * (M...) addresses and contract ids (C...) are rejected: payouts and wallet
 * sign-in need a plain account.
 */
export const isAccountAddress = (value: unknown): value is string =>
  typeof value === 'string' && StrKey.isValidEd25519PublicKey(value);

/** `GABC…WXYZ`, the public display form the PRD asks for. */
export const shortAddress = (address: string): string =>
  `${address.slice(0, 4)}…${address.slice(-4)}`;
