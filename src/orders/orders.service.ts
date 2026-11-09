import { createHash, createHmac } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verify } from '@node-rs/argon2';
import { TransactionBuilder } from '@stellar/stellar-sdk';
import type { Operation, Transaction } from '@stellar/stellar-sdk';
import { recordAudit } from '../audit/audit.queries.js';
import type { AuthUser } from '../auth/auth-user.js';
import { type Page, type PaginationQueryDto, toPage } from '../common/pagination.js';
import type { EnvVars } from '../config/env.validation.js';
import { Database } from '../database/database.js';
import type { DeliveryAddress } from '../database/schema/index.js';
import { MailService } from '../mail/mail.service.js';
import { EscrowService } from '../payments/escrow.service.js';
import { PaymentWatcher } from '../payments/watcher.service.js';
import { ProductsService } from '../products/products.service.js';
import { fromStroops, toStroops } from '../stellar/amounts.js';
import { LedgerUnavailableError, StellarLedger } from '../stellar/ledger.js';
import { StellarConfig } from '../stellar/stellar.config.js';
import {
  buildPayment,
  explainFailure,
  newMemo,
  sep7PayUri,
} from '../stellar/transactions.js';
import { findUserById, lockUser } from '../users/users.queries.js';
import { findWalletFor, updateWallet } from '../wallets/wallets.queries.js';
import { WalletsService } from '../wallets/wallets.service.js';
import type {
  CheckoutDto,
  CustomerVendorOrderDto,
  OrderDto,
  OrderLineDto,
  PayPageDto,
  PaymentInstructionsDto,
  PreparedPaymentDto,
  VendorOrderDto,
  VendorOrdersQueryDto,
  VendorStatusDto,
} from './dto/orders.dto.js';
import {
  findOrder,
  findOrderByPayLink,
  findVendorOrder,
  findVendorOrderForVendor,
  insertLines,
  insertOrder,
  insertVendorOrder,
  linesFor,
  listCustomerOrders,
  listVendorOrders,
  lockCartForCheckout,
  changeStock,
  lockOrder,
  lockVendorOrder,
  type OrderLineRow,
  type OrderRow,
  paymentsForOrder,
  updateOrder,
  updateVendorOrder,
  vendorOrdersFor,
} from './orders.queries.js';
import {
  amountDue,
  canMove,
  canReportProblem,
  commissionBpsFor,
  split,
} from './rules.js';

const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 15 * 60_000;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly windowMs: number;
  private readonly commissionBps: number;
  private readonly foundingDays: number;
  private readonly releaseDays: number;
  private readonly problemDays: number;
  private readonly linkSecret: string;
  private readonly siteUrl: string;

  constructor(
    private readonly database: Database,
    private readonly stellar: StellarConfig,
    private readonly ledger: StellarLedger,
    private readonly wallets: WalletsService,
    private readonly watcher: PaymentWatcher,
    private readonly escrow: EscrowService,
    private readonly products: ProductsService,
    private readonly mail: MailService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.windowMs = config.get('PAYMENT_WINDOW_MINUTES', { infer: true }) * 60_000;
    this.commissionBps = config.get('COMMISSION_BPS', { infer: true });
    this.foundingDays = config.get('FOUNDING_VENDOR_FREE_DAYS', { infer: true });
    this.releaseDays = config.get('ESCROW_AUTO_RELEASE_DAYS', { infer: true });
    this.problemDays = config.get('PROBLEM_REPORT_DAYS', { infer: true });
    this.linkSecret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.siteUrl = config.get('FRONTEND_URL', { infer: true }).replace(/\/+$/, '');
  }

  /* ---------------- checkout ---------------- */

  /**
   * Turns the cart into an order (PRD C5–C6): checks stock and holds it for
   * the payment window, splits it per vendor with commission, and returns the
   * payment instructions for every method.
   */
  async checkout(user: AuthUser, dto: CheckoutDto): Promise<OrderDto> {
    // Fails early (503) when payments are not set up, before stock is held.
    await this.wallets.settlement();
    const orderId = await this.database.transaction(async (tx) => {
      await lockUser(tx, user.id, 'update');
      const lines = await lockCartForCheckout(tx, user.id);
      if (lines.length === 0) throw new BadRequestException('Your cart is empty');
      const problems = lines
        .filter((l) => !l.visible || l.stock < l.quantity)
        .map((l) =>
          !l.visible
            ? `${l.title} is no longer available`
            : l.stock === 0
              ? `${l.title} is sold out`
              : `Only ${l.stock} of ${l.title} left`,
        );
      if (problems.length > 0)
        throw new ConflictException({
          message: 'Some items in your cart changed. Review your cart and try again',
          details: problems,
        });

      const byVendor = new Map<string, typeof lines>();
      for (const l of lines) byVendor.set(l.vendorId, [...(byVendor.get(l.vendorId) ?? []), l]);
      const total = lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0);
      const number = newMemo('FY');
      const order = await insertOrder(tx, {
        number,
        customerId: user.id,
        totalCents: total,
        deliveryAddress: {
          ...dto.deliveryAddress,
          line2: dto.deliveryAddress.line2 ?? null,
          notes: dto.deliveryAddress.notes ?? null,
        },
        payLinkHash: sha256(this.payLinkToken(number)),
        expiresAt: new Date(Date.now() + this.windowMs),
      });
      for (const [vendorId, vendorLines] of byVendor) {
        const subtotal = vendorLines.reduce((s, l) => s + l.priceCents * l.quantity, 0);
        const bps = commissionBpsFor(vendorLines[0], this.commissionBps, this.foundingDays);
        const vo = await insertVendorOrder(tx, {
          orderId: order.id,
          vendorId,
          subtotalCents: subtotal,
          commissionBps: bps,
          ...split(subtotal, bps),
        });
        await insertLines(
          tx,
          vendorLines.map((l) => ({
            vendorOrderId: vo.id,
            productId: l.productId,
            title: l.title,
            unitPriceCents: l.priceCents,
            quantity: l.quantity,
          })),
        );
        for (const l of vendorLines) await changeStock(tx, l.productId, -l.quantity);
      }
      await recordAudit(tx, {
        action: 'order.created',
        actorId: user.id,
        resourceType: 'order',
        resourceId: order.id,
        metadata: { number, totalCents: total, vendors: byVendor.size },
      });
      return order.id;
    });
    return this.get(user.id, orderId);
  }

  /* ---------------- customer ---------------- */

  async list(userId: string, page: PaginationQueryDto): Promise<Page<OrderDto>> {
    const { rows, total } = await listCustomerOrders(this.database.db, userId, page);
    return toPage(await Promise.all(rows.map((o) => this.toDto(o))), total, page);
  }

  async get(userId: string, id: string): Promise<OrderDto> {
    return this.toDto(await this.owned(userId, id));
  }

  /** PRD C6 "connect external wallet": builds the payment for the wallet to sign. */
  async prepareExternal(userId: string, id: string, source: string): Promise<PreparedPaymentDto> {
    const order = await this.payable(userId, id);
    const settlement = await this.wallets.settlement();
    if (source === settlement.publicKey) throw new BadRequestException('That is the Fysi account');
    let account;
    try {
      account = await this.ledger.loadAccount(source);
    } catch (err) {
      if (err instanceof LedgerUnavailableError)
        throw new ServiceUnavailableException('The Stellar network could not be reached. Try again shortly');
      throw err;
    }
    if (!account)
      throw new BadRequestException('This wallet does not exist on the network yet: fund it first');
    const due = amountDue(order);
    const held = account.balances.find((b) => b.assetId === this.wallets.asset.id);
    if (!held)
      throw new BadRequestException(
        `This wallet cannot hold ${this.wallets.asset.code}: add the trustline first`,
      );
    if (toStroops(held.balance) < due)
      throw new BadRequestException(
        `Not enough ${this.wallets.asset.code}: ${fromStroops(due)} needed, the wallet holds ${held.balance}`,
      );
    const tx = buildPayment(
      account,
      { destination: settlement.publicKey, asset: this.wallets.asset, amount: due, memo: order.number },
      { ...(await this.wallets.ctx()), ttlSeconds: 600 },
    );
    return {
      transaction: tx.toEnvelope().toXDR('base64'),
      networkPassphrase: this.stellar.networkPassphrase,
      amount: fromStroops(due),
      expiresAt: new Date(Number(tx.timeBounds!.maxTime) * 1000),
    };
  }

  /**
   * Submits the wallet-signed payment. It must pay the settlement account in
   * USDC with this order's memo; the watcher then credits the order.
   */
  async submitExternal(userId: string, id: string, signedXdr: string): Promise<OrderDto> {
    const order = await this.payable(userId, id);
    const settlement = await this.wallets.settlement();
    let tx: Transaction;
    try {
      const parsed = TransactionBuilder.fromXDR(signedXdr, this.stellar.networkPassphrase);
      if ('innerTransaction' in parsed) throw new Error('fee bump');
      tx = parsed;
    } catch {
      throw new BadRequestException('That is not a valid signed transaction for this network');
    }
    const op = tx.operations[0] as Operation.Payment | undefined;
    const memo = tx.memo.value ? Buffer.from(tx.memo.value as Uint8Array).toString() : '';
    if (
      tx.operations.length !== 1 ||
      op?.type !== 'payment' ||
      op.destination !== settlement.publicKey ||
      op.asset.isNative() ||
      `${op.asset.getCode()}:${op.asset.getIssuer()}` !== this.wallets.asset.id ||
      memo !== order.number
    )
      throw new BadRequestException(
        'This is not the payment for this order. Prepare it again and sign it unchanged',
      );
    if (tx.signatures.length === 0) throw new BadRequestException('The transaction is not signed');
    await this.send(signedXdr);
    return this.get(userId, id);
  }

  /** PRD C6 "pay with Fysi wallet": one tap plus PIN, Fysi signs. */
  async payWithWallet(userId: string, id: string, pin: string): Promise<OrderDto> {
    const order = await this.payable(userId, id);
    const wallet = await findWalletFor(this.database.db, userId, 'customer');
    if (!wallet) throw new ConflictException('Create your Fysi wallet first');
    if (wallet.status !== 'active')
      throw new ConflictException('Your Fysi wallet is still opening. Try again in a minute');
    await this.checkPin(wallet, pin);
    const due = amountDue(order);
    const balance = (await this.wallets.balance(wallet.publicKey)) ?? 0n;
    if (balance < due)
      throw new ConflictException({
        message: 'Your Fysi wallet balance is too low. Fund it first',
        details: [`needed ${fromStroops(due)}`, `balance ${fromStroops(balance)}`],
      });
    const settlement = await this.wallets.settlement();
    const built = await this.wallets.buildFromCustodial(wallet, {
      destination: settlement.publicKey,
      amount: due,
      memo: order.number,
    });
    await this.send(built.xdr);
    return this.get(userId, id);
  }

  async cancel(userId: string, id: string): Promise<OrderDto> {
    await this.database.transaction(async (tx) => {
      const order = await lockOrder(tx, (await this.owned(userId, id)).id);
      if (order.status !== 'awaiting_payment')
        throw new ConflictException(`This order is ${order.status.replace('_', ' ')}`);
      if (order.paidStroops > 0n)
        throw new ConflictException('Part of this order is paid. Pay the rest, or contact support for a refund');
      await this.escrow.closeUnpaid(tx, order.id, false);
      await updateOrder(tx, order.id, { status: 'cancelled', closedAt: new Date() });
      await recordAudit(tx, { action: 'order.cancelled', actorId: userId, resourceType: 'order', resourceId: order.id });
    });
    return this.get(userId, id);
  }

  /** PRD C8 "Confirm delivery": releases the vendor's payout. */
  async confirmDelivery(userId: string, id: string, voId: string): Promise<OrderDto> {
    const order = await this.owned(userId, id);
    await this.database.transaction(async (tx) => {
      const vo = await lockVendorOrder(tx, voId);
      if (vo?.orderId !== order.id) throw new NotFoundException('Vendor order not found');
      if (!['shipped', 'delivered'].includes(vo.status) || vo.escrowStatus !== 'held')
        throw new ConflictException('This part of the order cannot be confirmed now');
      const now = new Date();
      await updateVendorOrder(tx, vo.id, {
        status: 'delivered',
        deliveredAt: vo.deliveredAt ?? now,
        confirmedAt: now,
      });
      await this.escrow.release(tx, vo, userId, 'Customer confirmed delivery');
    });
    return this.get(userId, id);
  }

  /** PRD C8 "Report a problem" (7 days after delivery): freezes the payout. */
  async reportProblem(userId: string, id: string, voId: string, reason: string): Promise<OrderDto> {
    const order = await this.owned(userId, id);
    await this.database.transaction(async (tx) => {
      const vo = await lockVendorOrder(tx, voId);
      if (vo?.orderId !== order.id) throw new NotFoundException('Vendor order not found');
      if (vo.escrowStatus === 'released')
        throw new ConflictException('Payment is already on its way to the vendor. Contact support');
      if (!canReportProblem(vo, this.problemDays))
        throw new ConflictException('A problem can be reported from shipping until 7 days after delivery');
      await updateVendorOrder(tx, vo.id, {
        escrowStatus: 'disputed',
        problemReportedAt: new Date(),
        problemReason: reason,
      });
      await recordAudit(tx, {
        action: 'vendor_order.disputed',
        actorId: userId,
        resourceType: 'vendor_order',
        resourceId: vo.id,
        metadata: { reason },
      });
    });
    return this.get(userId, id);
  }

  /* ---------------- pay link (public) ---------------- */

  async payPage(token: string): Promise<PayPageDto> {
    const order = await findOrderByPayLink(this.database.db, sha256(token));
    if (!order) throw new NotFoundException('Payment link not found');
    const vos = await vendorOrdersFor(this.database.db, [order.id]);
    const lines = await linesFor(this.database.db, vos.map((v) => v.vo.id));
    return {
      number: order.number,
      status: order.status,
      total: this.products.price(order.totalCents),
      paid: fromStroops(order.paidStroops),
      items: lines.map((l) => `${l.title} × ${l.quantity}`),
      payment: await this.instructions(order),
    };
  }

  /* ---------------- vendor ---------------- */

  async vendorList(vendorId: string, q: VendorOrdersQueryDto): Promise<Page<VendorOrderDto>> {
    const { rows, total } = await listVendorOrders(this.database.db, vendorId, q, q);
    const lines = await linesFor(this.database.db, rows.map((r) => r.vo.id));
    return toPage(rows.map((r) => this.toVendorDto(r, lines)), total, q);
  }

  async vendorGet(vendorId: string, id: string): Promise<VendorOrderDto> {
    const row = await findVendorOrderForVendor(this.database.db, vendorId, id);
    if (!row) throw new NotFoundException('Order not found');
    return this.toVendorDto(row, await linesFor(this.database.db, [id]));
  }

  /** PRD V8: Processing → Shipped (with tracking) → Delivered. */
  async vendorUpdate(vendorId: string, id: string, dto: VendorStatusDto): Promise<VendorOrderDto> {
    let shipped = false;
    await this.database.transaction(async (tx) => {
      const current = await findVendorOrderForVendor(tx, vendorId, id);
      if (!current) throw new NotFoundException('Order not found');
      const vo = (await lockVendorOrder(tx, id))!;
      if (vo.escrowStatus === 'refunded' || vo.status === 'cancelled')
        throw new ConflictException('This order was cancelled');
      if (!canMove(vo.status, dto.status))
        throw new ConflictException(`An order that is ${vo.status} cannot become ${dto.status}`);
      const now = new Date();
      await updateVendorOrder(tx, id, {
        status: dto.status,
        ...(dto.carrier !== undefined && { carrier: dto.carrier }),
        ...(dto.trackingNumber !== undefined && { trackingNumber: dto.trackingNumber }),
        ...(dto.status === 'shipped' && {
          shippedAt: now,
          autoReleaseAt: new Date(now.getTime() + this.releaseDays * 86_400_000),
        }),
        // Marking delivered does not release escrow: only the customer's
        // confirmation or the 7-day timer after shipping does.
        ...(dto.status === 'delivered' && { deliveredAt: now }),
      });
      await recordAudit(tx, {
        action: `vendor_order.${dto.status}`,
        actorId: vendorId,
        resourceType: 'vendor_order',
        resourceId: id,
        metadata: { trackingNumber: dto.trackingNumber ?? null },
      });
      if (dto.status === 'shipped') shipped = true;
    });
    if (shipped) void this.sendShipped(id);
    return this.vendorGet(vendorId, id);
  }

  /* ---------------- helpers ---------------- */

  /** Deterministic per order, so the owner can always see the link again. */
  private payLinkToken(number: string) {
    return createHmac('sha256', this.linkSecret).update(`paylink:${number}`).digest('base64url').slice(0, 32);
  }

  private async owned(userId: string, id: string): Promise<OrderRow> {
    const order = await findOrder(this.database.db, id);
    if (order?.customerId !== userId) throw new NotFoundException('Order not found');
    return order;
  }

  private async payable(userId: string, id: string): Promise<OrderRow> {
    const order = await this.owned(userId, id);
    if (order.status !== 'awaiting_payment')
      throw new ConflictException(`This order is ${order.status.replace('_', ' ')}`);
    if (order.expiresAt <= new Date())
      throw new ConflictException('The payment window closed. Check out again');
    return order;
  }

  /** Submits, then syncs the watcher so the order shows Paid straight away. */
  private async send(xdr: string): Promise<void> {
    let outcome;
    try {
      outcome = await this.wallets.submit(xdr);
    } catch (err) {
      if (err instanceof LedgerUnavailableError) {
        // The payment may still land; the watcher will credit it.
        this.logger.warn('Payment submit outcome unknown');
        return;
      }
      throw err;
    }
    if (outcome.kind === 'failed')
      throw new BadRequestException(explainFailure(outcome.codes, this.wallets.asset.code));
    await this.watcher.sync().catch((err: unknown) =>
      this.logger.warn({ err }, 'Sync after payment failed; the scheduler will retry'),
    );
  }

  private async checkPin(
    wallet: { id: string; pinHash: string | null; pinFailures: number; pinLockedUntil: Date | null },
    pin: string,
  ) {
    if (wallet.pinLockedUntil && wallet.pinLockedUntil > new Date())
      throw new ForbiddenException('Too many wrong PINs. Try again in 15 minutes');
    if (!wallet.pinHash || !(await verify(wallet.pinHash, pin))) {
      const failures = wallet.pinFailures + 1;
      await updateWallet(this.database.db, wallet.id, {
        pinFailures: failures >= PIN_MAX_FAILURES ? 0 : failures,
        pinLockedUntil: failures >= PIN_MAX_FAILURES ? new Date(Date.now() + PIN_LOCK_MS) : null,
      });
      throw new ForbiddenException('Wrong PIN');
    }
    if (wallet.pinFailures > 0) await updateWallet(this.database.db, wallet.id, { pinFailures: 0 });
  }

  private async instructions(order: OrderRow): Promise<PaymentInstructionsDto | null> {
    if (order.status !== 'awaiting_payment' || order.expiresAt <= new Date()) return null;
    const settlement = await this.wallets.settlement().catch(() => null);
    if (!settlement) return null;
    const due = amountDue(order);
    const asset = this.wallets.asset;
    return {
      network: this.stellar.network,
      networkPassphrase: this.stellar.networkPassphrase,
      destination: settlement.publicKey,
      assetCode: asset.code,
      assetIssuer: asset.issuer!,
      memo: order.number,
      amountDue: fromStroops(due),
      sep7Uri: sep7PayUri({
        destination: settlement.publicKey,
        amount: due,
        asset,
        memo: order.number,
        message: `Fysi order ${order.number}`,
        networkPassphrase: this.stellar.isTestnet ? this.stellar.networkPassphrase : undefined,
      }),
      payLink: `${this.siteUrl}/pay/${this.payLinkToken(order.number)}`,
      expiresAt: order.expiresAt,
    };
  }

  private line(l: OrderLineRow): OrderLineDto {
    return {
      productId: l.productId,
      title: l.title,
      unitPrice: this.products.price(l.unitPriceCents),
      quantity: l.quantity,
      lineTotal: this.products.price(l.unitPriceCents * l.quantity),
    };
  }

  private async toDto(order: OrderRow): Promise<OrderDto> {
    const db = this.database.db;
    const [vos, pays] = await Promise.all([vendorOrdersFor(db, [order.id]), paymentsForOrder(db, order.id)]);
    const lines = await linesFor(db, vos.map((v) => v.vo.id));
    const vendorOrders: CustomerVendorOrderDto[] = vos.map(({ vo, vendorName, vendorSlug }) => ({
      id: vo.id,
      vendorName: vendorName ?? 'Vendor',
      vendorSlug,
      status: vo.status,
      subtotal: this.products.price(vo.subtotalCents),
      lines: lines.filter((l) => l.vendorOrderId === vo.id).map((l) => this.line(l)),
      carrier: vo.carrier,
      trackingNumber: vo.trackingNumber,
      shippedAt: vo.shippedAt,
      deliveredAt: vo.deliveredAt,
      confirmedAt: vo.confirmedAt,
      canConfirmDelivery: ['shipped', 'delivered'].includes(vo.status) && vo.escrowStatus === 'held',
      canReportProblem: vo.escrowStatus !== 'released' && canReportProblem(vo, this.problemDays),
      problemReason: vo.problemReason,
    }));
    return {
      id: order.id,
      number: order.number,
      status: order.status,
      total: this.products.price(order.totalCents),
      paid: fromStroops(order.paidStroops),
      deliveryAddress: order.deliveryAddress,
      payment: await this.instructions(order),
      transactions: pays
        .filter((p) => p.status !== 'unmatched')
        .map((p) => ({
          txHash: p.txHash,
          explorerUrl: this.stellar.transactionUrl(p.txHash),
          amount: fromStroops(p.amountStroops),
          at: p.closedAt,
        })),
      vendorOrders,
      paidAt: order.paidAt,
      createdAt: order.createdAt,
    };
  }

  private toVendorDto(
    r: {
      vo: Awaited<ReturnType<typeof lockVendorOrder>> & object;
      orderNumber: string;
      paidAt: Date | null;
      deliveryAddress: DeliveryAddress;
      customerName: string;
    },
    lines: OrderLineRow[],
  ): VendorOrderDto {
    const vo = r.vo;
    return {
      id: vo.id,
      orderNumber: r.orderNumber,
      status: vo.status,
      lines: lines.filter((l) => l.vendorOrderId === vo.id).map((l) => this.line(l)),
      subtotal: this.products.price(vo.subtotalCents),
      commissionBps: vo.commissionBps,
      commission: this.products.price(vo.commissionCents),
      payout: this.products.price(vo.payoutCents),
      escrowStatus: vo.escrowStatus,
      autoReleaseAt: vo.autoReleaseAt,
      customerName: r.customerName,
      deliveryAddress: r.deliveryAddress,
      carrier: vo.carrier,
      trackingNumber: vo.trackingNumber,
      problemReason: vo.problemReason,
      paidAt: r.paidAt,
      shippedAt: vo.shippedAt,
      deliveredAt: vo.deliveredAt,
    };
  }

  private async sendShipped(voId: string) {
    try {
      const db = this.database.db;
      const vo = await findVendorOrder(db, voId);
      if (!vo?.trackingNumber) return;
      const order = await findOrder(db, vo.orderId);
      const [customer, vendorRow] = await Promise.all([
        order ? findUserById(db, order.customerId) : undefined,
        vendorOrdersFor(db, [vo.orderId]),
      ]);
      const vendorName = vendorRow.find((v) => v.vo.id === voId)?.vendorName ?? 'Your vendor';
      if (customer && order)
        await this.mail.sendOrderShipped(customer.email, {
          number: order.number,
          vendorName,
          carrier: vo.carrier,
          trackingNumber: vo.trackingNumber,
        });
    } catch (err) {
      this.logger.error({ err, vendorOrderId: voId }, 'Failed to send shipped email');
    }
  }
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
