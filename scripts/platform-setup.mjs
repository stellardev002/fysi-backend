// Opens the Fysi settlement account: the platform account every order pays,
// which holds escrow, sponsors custodial wallets' reserves and pays their fees.
//
//   pnpm platform:setup
//
// On testnet it is funded by Friendbot. On mainnet, fund the printed address
// with XLM first (reserves for every custodial wallet plus fees), then run this
// again. Idempotent: safe to run on every deploy.
process.env.WATCHER_INTERVAL_MS = '0';
process.env.SWEEP_INTERVAL_SECONDS = '0';
process.env.LOG_LEVEL ??= 'warn';

const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('../dist/app.module.js');
const { WalletsService } = await import('../dist/wallets/wallets.service.js');

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
try {
  const settlement = await app.get(WalletsService).setupSettlement();
  console.log(`Settlement account ready: ${settlement.publicKey}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await app.close();
}
