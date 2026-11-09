/**
 * Money. Prices are US dollars held as integer cents, and settle 1:1 in USDC
 * on Stellar, so there is no exchange rate. Nothing goes through floats.
 */

/** 1 cent = 100,000 stroops (USDC has 7 decimals on Stellar). */
export const STROOPS_PER_CENT = 100_000n;

/** 1250 → "12.50". */
export const formatCents = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

/** Cents → USDC stroops, exact. */
export const centsToStroops = (cents: number): bigint =>
  BigInt(cents) * STROOPS_PER_CENT;

/**
 * USDC stroops → whole cents, rounded down, plus the stroops left over.
 * Payments are always built from cents, so a remainder means someone paid an
 * amount the platform never asked for (e.g. 12.5000001).
 */
export const stroopsToCents = (
  stroops: bigint,
): { cents: number; remainder: bigint } => ({
  cents: Number(stroops / STROOPS_PER_CENT),
  remainder: stroops % STROOPS_PER_CENT,
});

/** `percent` of an amount in cents, rounded half up (commission). */
export const percentOf = (cents: number, basisPoints: number): number =>
  Math.floor((cents * basisPoints + 5_000) / 10_000);
