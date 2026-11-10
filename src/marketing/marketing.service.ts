import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, count, desc, eq, lte, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/audit.queries.js';
import type { AuthUser } from '../auth/auth-user.js';
import { type Page, toPage } from '../common/pagination.js';
import type { EnvVars } from '../config/env.validation.js';
import { Database, type Executor } from '../database/database.js';
import {
  type CampaignAudience,
  campaignDeliveries,
  campaigns,
  newsletterSubscribers,
  type Role,
  userSuspensions,
  users,
} from '../database/schema/index.js';
import { MailService } from '../mail/mail.service.js';
import { findUserByEmail, findUserById } from '../users/users.queries.js';
import type {
  CampaignDto,
  CampaignsQueryDto,
  CreateCampaignDto,
  NewsletterStatusDto,
  SubscriberDto,
  SubscribersQueryDto,
  UpdateCampaignDto,
} from './dto/marketing.dto.js';

type CampaignRow = typeof campaigns.$inferSelect;

/** Cluster-wide lock so two instances never mail the same batch. */
const CAMPAIGN_LOCK_ID = 727_401;
/** Emails per sweep, so one campaign does not hold the sweeper for long. */
const BATCH = 100;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/** Newsletter list and admin email campaigns. */
@Injectable()
export class MarketingService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MarketingService.name);
  private readonly secret: string;
  private readonly sweepMs: number;
  private timer?: NodeJS.Timeout;
  private inflight?: Promise<void>;

  constructor(
    private readonly database: Database,
    private readonly mail: MailService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.secret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.sweepMs = config.get('SWEEP_INTERVAL_SECONDS', { infer: true }) * 1000;
  }

  onApplicationBootstrap() {
    if (this.sweepMs <= 0) return;
    this.timer = setInterval(() => void this.processCampaigns(), this.sweepMs);
    this.timer.unref();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  /* ---------------- newsletter ---------------- */

  /** Same answer whether the address was new or already on the list. */
  async subscribe(email: string, source: string | null, userId?: string): Promise<NewsletterStatusDto> {
    const account = userId ? await findUserById(this.database.db, userId) : await findUserByEmail(this.database.db, email);
    const [row] = await this.database.db
      .insert(newsletterSubscribers)
      .values({ email, source, userId: account?.email === email ? account.id : null })
      .onConflictDoUpdate({
        target: newsletterSubscribers.email,
        set: {
          status: 'subscribed',
          subscribedAt: sql`case when ${newsletterSubscribers.status} = 'subscribed' then ${newsletterSubscribers.subscribedAt} else now() end`,
          unsubscribedAt: null,
        },
      })
      // now() is the statement's transaction time: equal only when this call (re)subscribed.
      .returning({ fresh: sql<boolean>`${newsletterSubscribers.subscribedAt} = now()` });
    if (row.fresh)
      void this.mail
        .sendNewsletterWelcome(email, this.unsubscribeUrl(email))
        .catch((err: unknown) => this.logger.error({ err }, 'Failed to send newsletter welcome'));
    return { email, subscribed: true };
  }

  /** From the link in any marketing email; also opts an account out of campaigns. */
  async unsubscribe(email: string, token: string): Promise<NewsletterStatusDto> {
    if (!this.tokenMatches(email, token)) throw new BadRequestException('This unsubscribe link is not valid');
    await this.optOut(this.database.db, email);
    return { email, subscribed: false };
  }

  async preference(userId: string): Promise<NewsletterStatusDto> {
    const user = await findUserById(this.database.db, userId);
    if (!user) throw new NotFoundException('Account not found');
    const [row] = await this.database.db
      .select({ status: newsletterSubscribers.status })
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, user.email))
      .limit(1);
    return { email: user.email, subscribed: row?.status === 'subscribed' };
  }

  async setPreference(userId: string, subscribed: boolean): Promise<NewsletterStatusDto> {
    const user = await findUserById(this.database.db, userId);
    if (!user) throw new NotFoundException('Account not found');
    if (subscribed) return this.subscribe(user.email, 'account', userId);
    await this.optOut(this.database.db, user.email);
    return { email: user.email, subscribed: false };
  }

  async subscribers(q: SubscribersQueryDto): Promise<Page<SubscriberDto>> {
    const db = this.database.db;
    const term = q.q?.trim();
    const where = and(
      q.status ? eq(newsletterSubscribers.status, q.status) : undefined,
      term ? sql`${newsletterSubscribers.email} ilike ${`%${escapeLike(term.toLowerCase())}%`}` : undefined,
    );
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(newsletterSubscribers)
        .where(where)
        .orderBy(desc(newsletterSubscribers.subscribedAt))
        .limit(q.limit)
        .offset(q.offset),
      db.select({ total: count() }).from(newsletterSubscribers).where(where),
    ]);
    return toPage(
      rows.map((r) => ({
        id: r.id,
        email: r.email,
        status: r.status,
        source: r.source,
        hasAccount: r.userId !== null,
        subscribedAt: r.subscribedAt,
        unsubscribedAt: r.unsubscribedAt,
      })),
      total,
      q,
    );
  }

  unsubscribeUrl(email: string): string {
    const qs = new URLSearchParams({ email, token: this.token(email) });
    return this.mail.siteLink(`/unsubscribe?${qs.toString()}`);
  }

  private async optOut(db: Executor, email: string) {
    await db
      .insert(newsletterSubscribers)
      .values({ email, status: 'unsubscribed', unsubscribedAt: new Date(), source: 'unsubscribe' })
      .onConflictDoUpdate({
        target: newsletterSubscribers.email,
        set: { status: 'unsubscribed', unsubscribedAt: new Date() },
      });
  }

  /** Deterministic, so every email to an address carries a working link. */
  private token(email: string) {
    return createHmac('sha256', this.secret).update(`unsubscribe:${email}`).digest('base64url').slice(0, 32);
  }

  private tokenMatches(email: string, token: string) {
    const a = Buffer.from(this.token(email));
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /* ---------------- campaigns ---------------- */

  async list(q: CampaignsQueryDto): Promise<Page<CampaignDto>> {
    const db = this.database.db;
    const where = q.status ? eq(campaigns.status, q.status) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      db.select().from(campaigns).where(where).orderBy(desc(campaigns.createdAt)).limit(q.limit).offset(q.offset),
      db.select({ total: count() }).from(campaigns).where(where),
    ]);
    return toPage(await Promise.all(rows.map((r) => this.toDto(r))), total, q);
  }

  async get(id: string): Promise<CampaignDto> {
    return this.toDto(await this.find(this.database.db, id));
  }

  async create(admin: AuthUser, dto: CreateCampaignDto): Promise<CampaignDto> {
    checkCta(dto.ctaLabel, dto.ctaUrl);
    const row = await this.database.transaction(async (tx) => {
      const [c] = await tx
        .insert(campaigns)
        .values({
          name: dto.name,
          subject: dto.subject,
          preheader: dto.preheader ?? null,
          heading: dto.heading,
          body: dto.body,
          ctaLabel: dto.ctaLabel ?? null,
          ctaUrl: dto.ctaUrl ?? null,
          audience: dto.audience,
          createdBy: admin.id,
        })
        .returning();
      await recordAudit(tx, { action: 'campaign.created', actorId: admin.id, resourceType: 'campaign', resourceId: c.id, metadata: { name: c.name, audience: c.audience } });
      return c;
    });
    return this.toDto(row);
  }

  async update(admin: AuthUser, id: string, dto: UpdateCampaignDto): Promise<CampaignDto> {
    const changes = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    if (Object.keys(changes).length === 0) throw new BadRequestException('No fields to update');
    const row = await this.database.transaction(async (tx) => {
      const c = await this.find(tx, id, true);
      if (!['draft', 'scheduled'].includes(c.status))
        throw new ConflictException(`A ${c.status} campaign cannot be edited`);
      checkCta(dto.ctaLabel === undefined ? c.ctaLabel : dto.ctaLabel, dto.ctaUrl === undefined ? c.ctaUrl : dto.ctaUrl);
      const [u] = await tx.update(campaigns).set(changes).where(eq(campaigns.id, id)).returning();
      await recordAudit(tx, { action: 'campaign.updated', actorId: admin.id, resourceType: 'campaign', resourceId: id, metadata: { fields: Object.keys(changes) } });
      return u;
    });
    return this.toDto(row);
  }

  async remove(admin: AuthUser, id: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const c = await this.find(tx, id, true);
      if (c.status !== 'draft') throw new ConflictException('Only drafts can be deleted; cancel a scheduled campaign instead');
      await tx.delete(campaigns).where(eq(campaigns.id, id));
      await recordAudit(tx, { action: 'campaign.deleted', actorId: admin.id, resourceType: 'campaign', resourceId: id, metadata: { name: c.name } });
    });
  }

  /** One copy to an admin's inbox, marked as a test. */
  async test(admin: AuthUser, id: string, email?: string): Promise<{ sentTo: string }> {
    const c = await this.find(this.database.db, id);
    const to = email ?? (await findUserById(this.database.db, admin.id))?.email;
    if (!to) throw new BadRequestException('Give an email address');
    await this.mail.sendCampaign(to, { ...c, subject: `[Test] ${c.subject}` }, this.unsubscribeUrl(to));
    return { sentTo: to };
  }

  /** Queues the campaign; the sweeper fixes the recipients when it starts and mails them in batches. */
  async send(admin: AuthUser, id: string, scheduledAt?: Date): Promise<CampaignDto> {
    if (scheduledAt && scheduledAt.getTime() < Date.now() - 60_000)
      throw new BadRequestException('scheduledAt is in the past');
    const row = await this.database.transaction(async (tx) => {
      const c = await this.find(tx, id, true);
      if (!['draft', 'scheduled'].includes(c.status))
        throw new ConflictException(`This campaign is already ${c.status}`);
      if ((await this.audienceSize(tx, c.audience)) === 0)
        throw new ConflictException('Nobody is in this audience yet');
      const [u] = await tx
        .update(campaigns)
        .set({ status: 'scheduled', scheduledAt: scheduledAt ?? new Date() })
        .where(eq(campaigns.id, id))
        .returning();
      await recordAudit(tx, { action: 'campaign.scheduled', actorId: admin.id, resourceType: 'campaign', resourceId: id, metadata: { scheduledAt: u.scheduledAt } });
      return u;
    });
    void this.processCampaigns();
    return this.toDto(row);
  }

  async cancel(admin: AuthUser, id: string): Promise<CampaignDto> {
    const row = await this.database.transaction(async (tx) => {
      const c = await this.find(tx, id, true);
      if (c.status !== 'scheduled') throw new ConflictException('Only a scheduled campaign can be cancelled');
      const [u] = await tx.update(campaigns).set({ status: 'cancelled' }).where(eq(campaigns.id, id)).returning();
      await recordAudit(tx, { action: 'campaign.cancelled', actorId: admin.id, resourceType: 'campaign', resourceId: id });
      return u;
    });
    return this.toDto(row);
  }

  /**
   * Sweeper: starts due campaigns (fixing their recipients) and mails one
   * batch of each campaign that is sending. Every address gets it once.
   */
  async processCampaigns(): Promise<void> {
    // A run already going: wait for it rather than start a second one.
    this.inflight ??= this.runCampaigns().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async runCampaigns(): Promise<void> {
    try {
      await this.database.exclusive(CAMPAIGN_LOCK_ID, async () => {
        const db = this.database.db;
        // The app's clock decided scheduledAt, so the app's clock decides when it is due.
        const due = await db
          .select()
          .from(campaigns)
          .where(and(eq(campaigns.status, 'scheduled'), lte(campaigns.scheduledAt, new Date())));
        for (const c of due) await this.start(c);
        const sending = await db.select().from(campaigns).where(eq(campaigns.status, 'sending'));
        for (const c of sending) await this.sendBatch(c);
      });
    } catch (err) {
      this.logger.error({ err }, 'Campaign sweep failed');
    }
  }

  private async start(c: CampaignRow) {
    await this.database.transaction(async (tx) => {
      await tx.execute(sql`
        insert into ${campaignDeliveries} (campaign_id, email)
        select ${c.id}::uuid, email from (${this.audienceSql(c.audience)}) a
        on conflict do nothing`);
      const [{ n }] = await tx
        .select({ n: count() })
        .from(campaignDeliveries)
        .where(eq(campaignDeliveries.campaignId, c.id));
      await tx
        .update(campaigns)
        .set({ status: 'sending', startedAt: new Date(), recipientCount: n })
        .where(eq(campaigns.id, c.id));
    });
  }

  private async sendBatch(c: CampaignRow) {
    const db = this.database.db;
    const batch = await db
      .select({ email: campaignDeliveries.email })
      .from(campaignDeliveries)
      .where(and(eq(campaignDeliveries.campaignId, c.id), eq(campaignDeliveries.status, 'pending')))
      .orderBy(asc(campaignDeliveries.email))
      .limit(BATCH);
    for (const { email } of batch) {
      let error: string | null = null;
      try {
        await this.mail.sendCampaign(email, c, this.unsubscribeUrl(email));
      } catch (err) {
        error = err instanceof Error ? err.message.slice(0, 300) : 'Send failed';
      }
      const one = and(eq(campaignDeliveries.campaignId, c.id), eq(campaignDeliveries.email, email));
      await db
        .update(campaignDeliveries)
        .set(error ? { status: 'failed', error } : { status: 'sent', sentAt: new Date() })
        .where(one);
      await db
        .update(campaigns)
        .set(error ? { failedCount: sql`${campaigns.failedCount} + 1` } : { sentCount: sql`${campaigns.sentCount} + 1` })
        .where(eq(campaigns.id, c.id));
    }
    if (batch.length < BATCH)
      await db.update(campaigns).set({ status: 'sent', sentAt: new Date() }).where(eq(campaigns.id, c.id));
  }

  /** Addresses for an audience, minus everyone who unsubscribed. */
  private audienceSql(audience: CampaignAudience) {
    if (audience === 'newsletter')
      return sql`select ${newsletterSubscribers.email} as email from ${newsletterSubscribers} where ${newsletterSubscribers.status} = 'subscribed'`;
    const roles: Role[] = audience === 'customers' ? ['customer'] : audience === 'vendors' ? ['vendor'] : ['customer', 'vendor'];
    return sql`select ${users.email} as email from ${users}
      where ${users.role} in (${sql.join(roles.map((r) => sql`${r}`), sql`, `)})
        and ${users.emailVerifiedAt} is not null and ${users.deletedAt} is null
        and not exists (select 1 from ${userSuspensions} where ${userSuspensions.userId} = ${users.id})
        and not exists (select 1 from ${newsletterSubscribers} where ${newsletterSubscribers.email} = ${users.email} and ${newsletterSubscribers.status} = 'unsubscribed')`;
  }

  private async audienceSize(db: Executor, audience: CampaignAudience): Promise<number> {
    const result = await db.execute<{ n: number }>(sql`select count(*)::int as n from (${this.audienceSql(audience)}) a`);
    return Number(result.rows[0]?.n ?? 0);
  }

  private async find(db: Executor, id: string, lock = false): Promise<CampaignRow> {
    const q = db.select().from(campaigns).where(eq(campaigns.id, id));
    const [row] = lock ? await q.for('update') : await q.limit(1);
    if (!row) throw new NotFoundException('Campaign not found');
    return row;
  }

  private async toDto(c: CampaignRow): Promise<CampaignDto> {
    const recipients = ['draft', 'scheduled'].includes(c.status)
      ? await this.audienceSize(this.database.db, c.audience)
      : c.recipientCount;
    return {
      id: c.id,
      name: c.name,
      subject: c.subject,
      preheader: c.preheader,
      heading: c.heading,
      body: c.body,
      ctaLabel: c.ctaLabel,
      ctaUrl: c.ctaUrl,
      audience: c.audience,
      status: c.status,
      recipientCount: recipients,
      sentCount: c.sentCount,
      failedCount: c.failedCount,
      scheduledAt: c.scheduledAt,
      sentAt: c.sentAt,
      createdBy: c.createdBy,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}

function checkCta(label: string | null | undefined, url: string | null | undefined) {
  if (!!label !== !!url) throw new BadRequestException('Give both ctaLabel and ctaUrl, or neither');
}
