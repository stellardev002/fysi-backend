import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProductsModule } from '../products/products.module.js';
import { WalletsModule } from '../wallets/wallets.module.js';
import { AdminPaymentsController } from './admin-payments.controller.js';
import { AdminPaymentsService } from './admin-payments.service.js';
import { EscrowService } from './escrow.service.js';
import { OrderNotifier } from './order-notifier.js';
import { PaymentsScheduler } from './scheduler.js';
import { TransfersService } from './transfers.service.js';
import { WalletAccountsService } from './wallet-accounts.service.js';
import {
  CustomerWalletController,
  VendorWalletController,
} from './wallets.controller.js';
import { PaymentWatcher } from './watcher.service.js';

@Module({
  imports: [WalletsModule, AuthModule, ProductsModule],
  controllers: [AdminPaymentsController, CustomerWalletController, VendorWalletController],
  providers: [
    PaymentWatcher,
    OrderNotifier,
    EscrowService,
    TransfersService,
    PaymentsScheduler,
    WalletAccountsService,
    AdminPaymentsService,
  ],
  exports: [PaymentWatcher, EscrowService, TransfersService, PaymentsScheduler],
})
export class PaymentsModule {}
