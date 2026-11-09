import type {
  EscrowStatus,
  FulfilmentStatus,
  OrderStatus,
} from '../database/schema/index.js';
import { centsToStroops, percentOf } from '../products/pricing.js';

const DAY_MS = 86_400_000;

/**
 * Commission for a vendor at checkout (PRD decision: 5% per order, 0% for
 * founding vendors in their first 3 months after approval).
 */
export function commissionBpsFor(
  vendor: { foundingVendor: boolean; approvedAt: Date | null },
  standardBps: number,
  foundingFreeDays: number,
  now = new Date(),
): number {
  if (
    vendor.foundingVendor &&
    vendor.approvedAt &&
    now.getTime() < vendor.approvedAt.getTime() + foundingFreeDays * DAY_MS
  )
    return 0;
  return standardBps;
}

export function split(subtotalCents: number, bps: number) {
  const commissionCents = percentOf(subtotalCents, bps);
  return { commissionCents, payoutCents: subtotalCents - commissionCents };
}

export type PaymentEffect =
  /** Fully paid with this payment; `excess` is overpaid stroops to refund. */
  | { kind: 'paid'; excess: bigint }
  /** Still short; `due` stroops remain. */
  | { kind: 'partial'; due: bigint }
  /** The order no longer takes payments: refund all of it. */
  | { kind: 'closed' };

/**
 * What one incoming payment does to an order (PRD payment rules 2–3):
 * underpaid stays open for the balance, overpaid is paid with the excess
 * flagged, and a closed order sends the whole payment to refunds.
 */
export function applyPayment(
  order: { status: OrderStatus; totalCents: number; paidStroops: bigint },
  amount: bigint,
): PaymentEffect {
  if (order.status !== 'awaiting_payment') return { kind: 'closed' };
  const total = centsToStroops(order.totalCents);
  const paid = order.paidStroops + amount;
  if (paid < total) return { kind: 'partial', due: total - paid };
  return { kind: 'paid', excess: paid - total };
}

/** Stroops still due on an open order. */
export const amountDue = (order: { totalCents: number; paidStroops: bigint }) => {
  const due = centsToStroops(order.totalCents) - order.paidStroops;
  return due > 0n ? due : 0n;
};

/** Vendor status moves (PRD V8). Cancelling a paid order goes through an admin refund. */
const NEXT: Partial<Record<FulfilmentStatus, FulfilmentStatus[]>> = {
  paid: ['processing', 'shipped'],
  processing: ['shipped'],
  shipped: ['delivered'],
};

export const canMove = (from: FulfilmentStatus, to: FulfilmentStatus) =>
  NEXT[from]?.includes(to) ?? false;

/** Escrow can be released to the vendor from these states. */
export const RELEASABLE: readonly EscrowStatus[] = ['held'];

/** Escrow can be refunded to the customer from these states (before payout). */
export const REFUNDABLE: readonly EscrowStatus[] = ['held', 'disputed'];

/**
 * A customer may report a problem from shipping until `days` after delivery
 * (or after the vendor marked it delivered), while the payout is not sent.
 */
export function canReportProblem(
  vo: { status: FulfilmentStatus; deliveredAt: Date | null; escrowStatus: EscrowStatus },
  days: number,
  now = new Date(),
): boolean {
  if (!['shipped', 'delivered'].includes(vo.status)) return false;
  if (!['held', 'released'].includes(vo.escrowStatus)) return false;
  if (vo.deliveredAt && now.getTime() > vo.deliveredAt.getTime() + days * DAY_MS) return false;
  return true;
}
