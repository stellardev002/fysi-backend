import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, isNull, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { recordAudit } from '../audit/audit.queries.js';
import type { AuthUser } from '../auth/auth-user.js';
import { type Page, toPage } from '../common/pagination.js';
import { Database, type Executor } from '../database/database.js';
import {
  isStaff,
  orders,
  products,
  supportTickets,
  type TicketCategory,
  ticketMessages,
  users,
  vendorOrders,
} from '../database/schema/index.js';
import { MailService } from '../mail/mail.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { newMemo } from '../stellar/transactions.js';
import { findUserById } from '../users/users.queries.js';
import type {
  AdminTicketDetailDto,
  AdminTicketsQueryDto,
  AdminTicketSummaryDto,
  CreateTicketDto,
  MyTicketsQueryDto,
  StaffReplyDto,
  TicketDetailDto,
  TicketMessageDto,
  TicketSummaryDto,
  UpdateTicketDto,
} from './dto/support.dto.js';

type TicketRow = typeof supportTickets.$inferSelect;

export interface NewTicket {
  userId: string | null;
  email: string;
  name: string;
  category: TicketCategory;
  subject: string;
  message: string;
  orderId?: string | null;
  vendorOrderId?: string | null;
  productId?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');
const assignee = alias(users, 'assignee');
const requester = alias(users, 'requester');
const STAFF_NAME = 'Fysi Support';

/** Help desk: Report a Problem form, order problem reports, admin replies. */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly database: Database,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  /* ---------------- requester ---------------- */

  /** The Report a Problem / contact form, signed in or as a guest. */
  async create(user: AuthUser | undefined, dto: CreateTicketDto): Promise<TicketDetailDto> {
    const db = this.database.db;
    let who: { userId: string | null; email: string; name: string };
    if (user) {
      const u = await findUserById(db, user.id);
      if (!u) throw new NotFoundException('Account not found');
      who = { userId: u.id, email: u.email, name: u.name };
    } else {
      if (!dto.email || !dto.name)
        throw new BadRequestException('Add your name and email so we can reply');
      who = { userId: null, email: dto.email, name: dto.name };
    }
    const links = user ? await this.links(db, user, dto) : { orderId: null, vendorOrderId: null };
    const productId = dto.productId ? await this.productExists(db, dto.productId) : null;
    // A guest's order number is kept in the text only: it is not proof of ownership.
    const message = !user && dto.orderNumber ? `Order: ${dto.orderNumber}\n\n${dto.message}` : dto.message;
    const ticket = await this.database.transaction((tx) =>
      this.open(tx, { ...who, ...links, productId, category: dto.category, subject: dto.subject, message }),
    );
    void this.afterOpen(ticket);
    return this.detail(ticket.id, who.userId ?? undefined, true);
  }

  /** Opens a ticket inside the caller's transaction; emails go out after commit via `afterOpen`. */
  async open(db: Executor, t: NewTicket): Promise<TicketRow> {
    const [ticket] = await db
      .insert(supportTickets)
      .values({
        number: newMemo('TK'),
        userId: t.userId,
        email: t.email,
        name: t.name,
        category: t.category,
        subject: t.subject,
        priority: t.priority ?? 'normal',
        orderId: t.orderId ?? null,
        vendorOrderId: t.vendorOrderId ?? null,
        productId: t.productId ?? null,
      })
      .returning();
    await db.insert(ticketMessages).values({
      ticketId: ticket.id,
      authorId: t.userId,
      authorType: 'requester',
      authorName: t.name,
      body: t.message,
    });
    await this.notifications.notifyStaff(db, {
      kind: 'ticket.new',
      title: `New ${t.category} request ${ticket.number}`,
      body: t.subject,
      link: `/admin/tickets/${ticket.id}`,
      data: { ticketId: ticket.id },
    });
    return ticket;
  }

  async afterOpen(ticket: TicketRow): Promise<void> {
    try {
      await this.mail.sendTicketReceived(ticket.email, { number: ticket.number, subject: ticket.subject });
    } catch (err) {
      this.logger.error({ err, ticketId: ticket.id }, 'Failed to send ticket confirmation');
    }
  }

  async mine(userId: string, q: MyTicketsQueryDto): Promise<Page<TicketSummaryDto>> {
    const db = this.database.db;
    const where = and(eq(supportTickets.userId, userId), q.status ? eq(supportTickets.status, q.status) : undefined);
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({ t: supportTickets, orderNumber: orders.number })
        .from(supportTickets)
        .leftJoin(orders, eq(orders.id, supportTickets.orderId))
        .where(where)
        .orderBy(desc(supportTickets.lastMessageAt))
        .limit(q.limit)
        .offset(q.offset),
      db.select({ total: count() }).from(supportTickets).where(where),
    ]);
    return toPage(rows.map((r) => summary(r.t, r.orderNumber)), total, q);
  }

  async detail(id: string, userId?: string, skipOwnerCheck = false): Promise<TicketDetailDto> {
    const db = this.database.db;
    const [row] = await db
      .select({ t: supportTickets, orderNumber: orders.number })
      .from(supportTickets)
      .leftJoin(orders, eq(orders.id, supportTickets.orderId))
      .where(eq(supportTickets.id, id))
      .limit(1);
    if (!row || (!skipOwnerCheck && row.t.userId !== userId)) throw new NotFoundException('Request not found');
    return {
      ...summary(row.t, row.orderNumber),
      messages: await this.messages(db, id),
      canReply: row.t.status !== 'closed',
    };
  }

  /** The requester replies; a resolved request reopens. */
  async reply(user: AuthUser, id: string, body: string): Promise<TicketDetailDto> {
    await this.database.transaction(async (tx) => {
      const t = await this.lock(tx, id);
      if (t?.userId !== user.id) throw new NotFoundException('Request not found');
      if (t.status === 'closed') throw new ConflictException('This request is closed. Open a new one');
      await tx.insert(ticketMessages).values({
        ticketId: id,
        authorId: user.id,
        authorType: 'requester',
        authorName: t.name,
        body,
      });
      await tx
        .update(supportTickets)
        .set({ status: 'open', lastMessageAt: new Date(), resolvedAt: null })
        .where(eq(supportTickets.id, id));
      // The assigned admin, or every admin while nobody owns it.
      const note = {
        kind: 'ticket.reply',
        title: `Reply on ${t.number}`,
        body: truncate(body, 120),
        link: `/admin/tickets/${id}`,
        data: { ticketId: id },
      };
      if (t.assignedTo) await this.notifications.notify(tx, t.assignedTo, note);
      else await this.notifications.notifyStaff(tx, note);
    });
    return this.detail(id, user.id);
  }

  async close(user: AuthUser, id: string): Promise<TicketDetailDto> {
    await this.database.transaction(async (tx) => {
      const t = await this.lock(tx, id);
      if (t?.userId !== user.id) throw new NotFoundException('Request not found');
      if (t.status === 'closed') return;
      await tx
        .update(supportTickets)
        .set({ status: 'closed', resolvedAt: t.resolvedAt ?? new Date() })
        .where(eq(supportTickets.id, id));
    });
    return this.detail(id, user.id);
  }

  /* ---------------- admin ---------------- */

  async adminList(admin: AuthUser, q: AdminTicketsQueryDto): Promise<Page<AdminTicketSummaryDto>> {
    const db = this.database.db;
    const term = q.q?.trim();
    const where = and(
      q.status ? eq(supportTickets.status, q.status) : undefined,
      q.category ? eq(supportTickets.category, q.category) : undefined,
      q.priority ? eq(supportTickets.priority, q.priority) : undefined,
      q.assignedTo === 'me'
        ? eq(supportTickets.assignedTo, admin.id)
        : q.assignedTo === 'none'
          ? isNull(supportTickets.assignedTo)
          : q.assignedTo
            ? eq(supportTickets.assignedTo, q.assignedTo)
            : undefined,
      term
        ? or(
            eq(supportTickets.number, term.toUpperCase()),
            eq(orders.number, term.toUpperCase()),
            sql`${supportTickets.email} ilike ${`%${escapeLike(term)}%`}`,
            sql`${supportTickets.subject} ilike ${`%${escapeLike(term)}%`}`,
          )
        : undefined,
    );
    const [rows, [{ total }]] = await Promise.all([
      this.adminSelect(db, where)
        .orderBy(
          // Urgent first, then the longest-waiting open request.
          sql`case ${supportTickets.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`,
          desc(supportTickets.lastMessageAt),
        )
        .limit(q.limit)
        .offset(q.offset),
      db
        .select({ total: count() })
        .from(supportTickets)
        .leftJoin(orders, eq(orders.id, supportTickets.orderId))
        .where(where),
    ]);
    return toPage(rows.map(adminSummary), total, q);
  }

  async adminDetail(id: string): Promise<AdminTicketDetailDto> {
    const db = this.database.db;
    const [row] = await this.adminSelect(db, eq(supportTickets.id, id)).limit(1);
    if (!row) throw new NotFoundException('Request not found');
    return { ...adminSummary(row), messages: await this.messages(db, id), resolvedAt: row.t.resolvedAt };
  }

  async staffReply(admin: AuthUser, id: string, dto: StaffReplyDto): Promise<AdminTicketDetailDto> {
    const status = dto.status ?? 'pending';
    const ticket = await this.database.transaction(async (tx) => {
      const t = await this.lock(tx, id);
      if (!t) throw new NotFoundException('Request not found');
      if (t.status === 'closed') throw new ConflictException('This request is closed');
      await tx.insert(ticketMessages).values({
        ticketId: id,
        authorId: admin.id,
        authorType: 'staff',
        authorName: STAFF_NAME,
        body: dto.body,
      });
      await tx
        .update(supportTickets)
        .set({
          status,
          lastMessageAt: new Date(),
          resolvedAt: status === 'resolved' ? new Date() : null,
          assignedTo: t.assignedTo ?? admin.id,
        })
        .where(eq(supportTickets.id, id));
      if (t.userId)
        await this.notifications.notify(tx, t.userId, {
          kind: 'ticket.reply',
          title: `Fysi Support replied to ${t.number}`,
          body: truncate(dto.body, 120),
          link: `/account/support/${id}`,
          data: { ticketId: id },
        });
      await recordAudit(tx, {
        action: 'ticket.replied',
        actorId: admin.id,
        resourceType: 'ticket',
        resourceId: id,
        metadata: { status },
      });
      return t;
    });
    try {
      await this.mail.sendTicketReply(ticket.email, {
        number: ticket.number,
        subject: ticket.subject,
        reply: dto.body,
        resolved: status === 'resolved',
      });
    } catch (err) {
      this.logger.error({ err, ticketId: id }, 'Failed to email the ticket reply');
    }
    return this.adminDetail(id);
  }

  async update(admin: AuthUser, id: string, dto: UpdateTicketDto): Promise<AdminTicketDetailDto> {
    if (dto.status === undefined && dto.priority === undefined && dto.assignedTo === undefined)
      throw new BadRequestException('No fields to update');
    await this.database.transaction(async (tx) => {
      const t = await this.lock(tx, id);
      if (!t) throw new NotFoundException('Request not found');
      if (dto.assignedTo) {
        const staff = await findUserById(tx, dto.assignedTo);
        if (!staff || !isStaff(staff.role) || staff.deletedAt)
          throw new BadRequestException('assignedTo must be an admin');
        if (staff.id !== admin.id)
          await this.notifications.notify(tx, staff.id, {
            kind: 'ticket.assigned',
            title: `${t.number} was assigned to you`,
            body: t.subject,
            link: `/admin/tickets/${id}`,
            data: { ticketId: id },
          });
      }
      await tx
        .update(supportTickets)
        .set({
          ...(dto.status !== undefined && {
            status: dto.status,
            resolvedAt: ['resolved', 'closed'].includes(dto.status) ? (t.resolvedAt ?? new Date()) : null,
          }),
          ...(dto.priority !== undefined && { priority: dto.priority }),
          ...(dto.assignedTo !== undefined && { assignedTo: dto.assignedTo }),
        })
        .where(eq(supportTickets.id, id));
      await recordAudit(tx, {
        action: 'ticket.updated',
        actorId: admin.id,
        resourceType: 'ticket',
        resourceId: id,
        before: { status: t.status, priority: t.priority, assignedTo: t.assignedTo },
        after: { ...dto },
      });
    });
    return this.adminDetail(id);
  }

  /** Counts for the admin help desk badge. */
  async queueCounts(): Promise<{ open: number; urgent: number }> {
    const [r] = await this.database.db
      .select({
        open: sql<number>`count(*) filter (where ${supportTickets.status} = 'open')::int`,
        urgent: sql<number>`count(*) filter (where ${supportTickets.status} in ('open', 'pending') and ${supportTickets.priority} = 'urgent')::int`,
      })
      .from(supportTickets);
    return r;
  }

  /* ---------------- helpers ---------------- */

  private adminSelect(db: Executor, where: SQL | undefined) {
    return db
      .select({
        t: supportTickets,
        orderNumber: orders.number,
        userRole: requester.role,
        assignedToName: assignee.name,
        messageCount: sql<number>`(select count(*)::int from ${ticketMessages} where ${ticketMessages.ticketId} = ${supportTickets.id})`,
      })
      .from(supportTickets)
      .leftJoin(orders, eq(orders.id, supportTickets.orderId))
      .leftJoin(requester, eq(requester.id, supportTickets.userId))
      .leftJoin(assignee, eq(assignee.id, supportTickets.assignedTo))
      .where(where)
      .$dynamic();
  }

  private async lock(db: Executor, id: string): Promise<TicketRow | undefined> {
    return (await db.select().from(supportTickets).where(eq(supportTickets.id, id)).for('update'))[0];
  }

  private async messages(db: Executor, ticketId: string): Promise<TicketMessageDto[]> {
    const rows = await db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, ticketId))
      .orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id));
    return rows.map((m) => ({
      id: m.id,
      authorType: m.authorType,
      authorName: m.authorName,
      body: m.body,
      createdAt: m.createdAt,
    }));
  }

  /** Links an order the caller is part of: their own (customer) or containing their items (vendor). */
  private async links(db: Executor, user: AuthUser, dto: CreateTicketDto) {
    if (!dto.orderNumber) return { orderId: null, vendorOrderId: null };
    const [order] = await db.select().from(orders).where(eq(orders.number, dto.orderNumber)).limit(1);
    if (order && order.customerId === user.id) return { orderId: order.id, vendorOrderId: null };
    if (order && user.role === 'vendor') {
      const [vo] = await db
        .select({ id: vendorOrders.id })
        .from(vendorOrders)
        .where(and(eq(vendorOrders.orderId, order.id), eq(vendorOrders.vendorId, user.id)))
        .limit(1);
      if (vo) return { orderId: order.id, vendorOrderId: vo.id };
    }
    throw new BadRequestException('That order number is not one of your orders');
  }

  private async productExists(db: Executor, id: string): Promise<string> {
    const [p] = await db.select({ id: products.id }).from(products).where(eq(products.id, id)).limit(1);
    if (!p) throw new BadRequestException('productId is not a product');
    return p.id;
  }
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const summary = (t: TicketRow, orderNumber: string | null): TicketSummaryDto => ({
  id: t.id,
  number: t.number,
  category: t.category,
  subject: t.subject,
  status: t.status,
  priority: t.priority,
  orderNumber,
  vendorOrderId: t.vendorOrderId,
  productId: t.productId,
  lastMessageAt: t.lastMessageAt,
  createdAt: t.createdAt,
});

const adminSummary = (r: {
  t: TicketRow;
  orderNumber: string | null;
  userRole: string | null;
  assignedToName: string | null;
  messageCount: number;
}): AdminTicketSummaryDto => ({
  ...summary(r.t, r.orderNumber),
  name: r.t.name,
  email: r.t.email,
  userId: r.t.userId,
  userRole: r.userRole,
  assignedTo: r.t.assignedTo,
  assignedToName: r.assignedToName,
  messageCount: Number(r.messageCount),
});
