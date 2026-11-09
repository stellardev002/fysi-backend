/** Stellar amounts have 7 decimal places; 1 unit = 10,000,000 stroops. */
export const STELLAR_DECIMALS = 7;
const SCALE = 10n ** BigInt(STELLAR_DECIMALS);
/** Largest amount Stellar can represent: int64 stroops. */
export const MAX_STROOPS = 2n ** 63n - 1n;

const AMOUNT = /^(\d+)(?:\.(\d{1,7}))?$/;

/**
 * Exact decimal string to integer stroops. Throws on anything that is not a
 * plain non-negative decimal with at most 7 places: money never goes through floats.
 */
export function toStroops(amount: string): bigint {
  const match = AMOUNT.exec(amount.trim());
  if (!match) throw new Error(`Invalid Stellar amount: ${amount}`);
  const [, whole, fraction = ''] = match;
  const stroops =
    BigInt(whole) * SCALE + BigInt(fraction.padEnd(STELLAR_DECIMALS, '0'));
  if (stroops > MAX_STROOPS)
    throw new Error(`Stellar amount too large: ${amount}`);
  return stroops;
}

/** Integer stroops to the shortest exact decimal string, e.g. 15000000n -> "1.5". */
export function fromStroops(stroops: bigint): string {
  if (stroops < 0n) return `-${fromStroops(-stroops)}`;
  const whole = stroops / SCALE;
  const fraction = (stroops % SCALE)
    .toString()
    .padStart(STELLAR_DECIMALS, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export const isStellarAmount = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    return toStroops(value) > 0n;
  } catch {
    return false;
  }
};
