import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../config/env.validation.js';
import { LedgerUnavailableError } from '../stellar/ledger.js';
import { WalletsService } from '../wallets/wallets.service.js';
import { EscrowService } from './escrow.service.js';
import { TransfersService } from './transfers.service.js';
import { PaymentWatcher } from './watcher.service.js';

/**
 * Background work. The watcher polls the settlement account every few seconds
 * (PRD: payment confirmed in under 10 s; every submit through the API also
 * syncs at once). The sweeper expires checkouts, releases escrow, opens
 * pending wallets and drives payouts, refunds and withdrawals.
 *
 * Needs an always-on host: on a sleeping host nothing is lost (the watcher
 * replays from its cursor), but confirmations wait for the next wake-up.
 */
@Injectable()
export class PaymentsScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentsScheduler.name);
  private readonly watchMs: number;
  private readonly sweepMs: number;
  private timers: NodeJS.Timeout[] = [];
  private sweeping = false;

  constructor(
    private readonly watcher: PaymentWatcher,
    private readonly escrow: EscrowService,
    private readonly transfers: TransfersService,
    private readonly wallets: WalletsService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.watchMs = config.get('WATCHER_INTERVAL_MS', { infer: true });
    this.sweepMs = config.get('SWEEP_INTERVAL_SECONDS', { infer: true }) * 1000;
  }

  onApplicationBootstrap() {
    if (this.watchMs > 0)
      this.timers.push(setInterval(() => void this.watch(), this.watchMs));
    if (this.sweepMs > 0)
      this.timers.push(setInterval(() => void this.sweep(), this.sweepMs));
    for (const t of this.timers) t.unref();
  }

  onApplicationShutdown() {
    for (const t of this.timers) clearInterval(t);
  }

  async watch() {
    try {
      await this.watcher.sync();
    } catch (err) {
      if (err instanceof LedgerUnavailableError) this.logger.warn('Horizon unreachable; watcher will retry');
      else this.logger.error({ err }, 'Payment watcher failed');
    }
  }

  /** One sweep; each step is independent so one failure does not stop the rest. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const steps: [string, () => Promise<unknown>][] = [
        ['expire orders', () => this.escrow.expireOrders()],
        ['auto-release escrow', () => this.escrow.autoRelease()],
        ['activate wallets', () => this.wallets.activatePending()],
        ['transfers', () => this.transfers.processAll()],
      ];
      for (const [name, step] of steps) {
        try {
          await step();
        } catch (err) {
          this.logger.error({ err }, `Sweep step failed: ${name}`);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
}
