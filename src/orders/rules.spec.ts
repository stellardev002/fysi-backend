import { describe, expect, it } from 'vitest';
import {
  amountDue,
  applyPayment,
  canMove,
  canReportProblem,
  commissionBpsFor,
  split,
} from './rules.js';

const DAY = 86_400_000;

describe('order rules', () => {
  it('waives commission for founding vendors in their first 90 days only', () => {
    const now = new Date('2026-12-01T00:00:00Z');
    const approved = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY);
    expect(commissionBpsFor({ foundingVendor: true, approvedAt: approved(10) }, 500, 90, now)).toBe(0);
    expect(commissionBpsFor({ foundingVendor: true, approvedAt: approved(91) }, 500, 90, now)).toBe(500);
    expect(commissionBpsFor({ foundingVendor: false, approvedAt: approved(1) }, 500, 90, now)).toBe(500);
  });

  it('splits a subtotal into commission and payout that add up', () => {
    expect(split(2550, 500)).toEqual({ commissionCents: 128, payoutCents: 2422 });
    expect(split(2550, 0)).toEqual({ commissionCents: 0, payoutCents: 2550 });
  });

  it('applies payments: partial, exact, overpaid, closed', () => {
    const open = { status: 'awaiting_payment' as const, totalCents: 1250, paidStroops: 0n };
    expect(applyPayment(open, 100_000_000n)).toEqual({ kind: 'partial', due: 25_000_000n });
    expect(applyPayment({ ...open, paidStroops: 100_000_000n }, 25_000_000n)).toEqual({
      kind: 'paid',
      excess: 0n,
    });
    expect(applyPayment(open, 130_000_000n)).toEqual({ kind: 'paid', excess: 5_000_000n });
    expect(applyPayment({ ...open, status: 'expired' }, 1n)).toEqual({ kind: 'closed' });
    expect(amountDue({ totalCents: 1250, paidStroops: 25_000_000n })).toBe(100_000_000n);
    expect(amountDue({ totalCents: 1250, paidStroops: 999_000_000n })).toBe(0n);
  });

  it('moves vendor orders forward only', () => {
    expect(canMove('paid', 'processing')).toBe(true);
    expect(canMove('paid', 'shipped')).toBe(true);
    expect(canMove('shipped', 'delivered')).toBe(true);
    expect(canMove('delivered', 'shipped')).toBe(false);
    expect(canMove('awaiting_payment', 'shipped')).toBe(false);
    expect(canMove('paid', 'delivered')).toBe(false);
  });

  it('allows problem reports from shipping until 7 days after delivery', () => {
    const now = new Date('2026-12-10T00:00:00Z');
    const vo = { status: 'delivered' as const, deliveredAt: new Date(now.getTime() - 6 * DAY), escrowStatus: 'held' as const };
    expect(canReportProblem(vo, 7, now)).toBe(true);
    expect(canReportProblem({ ...vo, deliveredAt: new Date(now.getTime() - 8 * DAY) }, 7, now)).toBe(false);
    expect(canReportProblem({ ...vo, status: 'paid' }, 7, now)).toBe(false);
    expect(canReportProblem({ ...vo, escrowStatus: 'paid_out' }, 7, now)).toBe(false);
    expect(canReportProblem({ ...vo, status: 'shipped', deliveredAt: null }, 7, now)).toBe(true);
  });
});
