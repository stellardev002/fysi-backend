import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, eq, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/audit.queries.js';
import { type Page, toPage } from '../common/pagination.js';
import { Database } from '../database/database.js';
import {
  payments,
  payouts,
  refunds,
  vendorOrders,
  vendors,
  withdrawals,
} from '../database/schema/index.js';
import { ProductsService } from '../products/products.service.js';
import { fromStroops } from '../stellar/amounts.js';
import { StellarConfig } from '../stellar/stellar.config.js';
import type {
  AdminPaymentDto,
  AdminPaymentsQueryDto,
  AdminTransferDto,
  AdminTransfersQueryDto,
  AdminVendorOrderDto,
  AdminVendorOrdersQueryDto,
  DashboardDto,
  DashboardQueryDto,
} from './dto/admin-payments.dto.js';
import {
  dashboardSeries,
  findTransfer,
  listPaymentsAdmin,
  listTransfersAdmin,
  listVendorOrdersAdmin,
  type TransferKind,
  updateTransfer,
} from './payments.queries.js';

/** PRD A2 (dashboard) and A4 (transaction monitor). */
@Injectable()
export class AdminPaymentsService {
  constructor(
    private readonly database: Database,
    private readonly stellar: StellarConfig,
    private readonly products: ProductsService,
  ) {}

  async payments(q: AdminPaymentsQueryDto): Promise<Page<AdminPaymentDto>> {
    const { rows, total } = await listPaymentsAdmin(this.database.db, q, q);
    return toPage(
      rows.map(({ payment: p, orderNumber }) => ({
        id: p.id,
        status: p.status,
        orderNumber,
        payer: p.fromAddress,
        amount: fromStroops(p.amountStroops),
        assetCode: p.assetId.split(':')[0],
        memo: p.memo,
        refundable: fromStroops(p.refundableStroops),
        note: p.note,
        txHash: p.txHash,
        explorerUrl: this.stellar.transactionUrl(p.txHash),
        at: p.closedAt,
      })),
      total,
      q,
    );
  }

  async transfers(kind: TransferKind, q: AdminTransfersQueryDto): Promise<Page<AdminTransferDto>> {
    const { rows, total } = await listTransfersAdmin(this.database.db, kind, q, q);
    return toPage(
      rows.map((t) => ({
        id: t.id,
        kind,
        destination: t.destination,
        amount: fromStroops(t.amountStroops),
        status: t.status,
        attempts: t.attempts,
        lastError: t.lastError,
        txHash: t.txHash,
        explorerUrl: t.txHash ? this.stellar.transactionUrl(t.txHash) : null,
        createdAt: t.createdAt,
      })),
      total,
      q,
    );
  }

  /** Puts a failed transfer back in the queue (after fixing the cause). */
  async retry(adminId: string, kind: TransferKind, id: string): Promise<void> {
    const t = await findTransfer(this.database.db, kind, id);
    if (!t) throw new NotFoundException('Transfer not found');
    if (t.status !== 'failed') throw new ConflictException(`This transfer is ${t.status}`);
    await this.database.transaction(async (tx) => {
      await updateTransfer(tx, kind, id, { status: 'queued', txHash: null, txExpiresAt: null, attempts: 0 });
      await recordAudit(tx, { action: `${kind}.retried`, actorId: adminId, resourceType: kind, resourceId: id });
    });
  }

  async vendorOrders(q: AdminVendorOrdersQueryDto): Promise<Page<AdminVendorOrderDto>> {
    const { rows, total } = await listVendorOrdersAdmin(this.database.db, q, q);
    return toPage(
      rows.map(({ vo, orderNumber, vendorName, customerEmail }) => ({
        id: vo.id,
        orderNumber,
        vendorName,
        customerEmail,
        status: vo.status,
        escrowStatus: vo.escrowStatus,
        subtotal: this.products.price(vo.subtotalCents),
        payout: this.products.price(vo.payoutCents),
        problemReason: vo.problemReason,
        trackingNumber: vo.trackingNumber,
        updatedAt: vo.updatedAt,
      })),
      total,
      q,
    );
  }

  async dashboard(q: DashboardQueryDto): Promise<DashboardDto> {
    const db = this.database.db;
    const from = new Date(Date.now() - q.days * 86_400_000);
    const [s, [vp], [pr], [dp], failed] = await Promise.all([
      dashboardSeries(db, q.period, from),
      db.select({ n: count() }).from(vendors).where(eq(vendors.status, 'pending')),
      db.select({ n: count() }).from(payments).where(sql`${payments.refundableStroops} > 0`),
      db.select({ n: count() }).from(vendorOrders).where(eq(vendorOrders.escrowStatus, 'disputed')),
      Promise.all(
        [payouts, refunds, withdrawals].map((t) =>
          db.select({ n: count() }).from(t).where(and(eq(t.status, 'failed'))),
        ),
      ),
    ]);
    const points = new Map<string, DashboardDto['series'][number]>();
    const point = (period: string) => {
      let p = points.get(period);
      if (!p) {
        p = { period, newVendors: 0, newCustomers: 0, paidOrders: 0, volume: this.products.price(0), failedPayments: 0 };
        points.set(period, p);
      }
      return p;
    };
    for (const r of s.vendorsRows) point(r.bucket).newVendors = r.n;
    for (const r of s.customerRows) point(r.bucket).newCustomers = r.n;
    for (const r of s.orderRows) {
      const p = point(r.bucket);
      p.paidOrders = r.n;
      p.volume = this.products.price(Number(r.cents));
    }
    for (const r of s.unmatchedRows) point(r.bucket).failedPayments = r.n;
    return {
      series: [...points.values()].sort((a, b) => a.period.localeCompare(b.period)),
      queues: {
        vendorsPending: vp.n,
        paymentsToRefund: pr.n,
        disputes: dp.n,
        transfersFailed: failed.reduce((sum, [r]) => sum + r.n, 0),
      },
    };
  }
}
