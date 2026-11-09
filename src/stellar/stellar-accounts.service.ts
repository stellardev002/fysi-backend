import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isAccountAddress, shortAddress } from './address.js';
import type { AccountSummaryDto, NetworkInfoDto } from './dto/stellar.dto.js';
import { LedgerUnavailableError, StellarLedger } from './ledger.js';
import { PlatformSigner } from './signer.js';
import { StellarConfig } from './stellar.config.js';

@Injectable()
export class StellarAccountsService {
  constructor(
    private readonly config: StellarConfig,
    private readonly ledger: StellarLedger,
    private readonly signer: PlatformSigner,
  ) {}

  networkInfo(): NetworkInfoDto {
    return {
      network: this.config.network,
      networkPassphrase: this.config.networkPassphrase,
      horizonUrl: this.config.horizonUrl,
      explorerUrl: this.config.explorerUrl,
      assets: this.config.assets.map(({ id, code, issuer, native }) => ({
        id,
        code,
        issuer,
        native,
      })),
      platformAccount: this.signer.configured ? this.signer.publicKey() : null,
    };
  }

  /** Whether the address exists on chain and which accepted assets it can hold. */
  async describe(address: string): Promise<AccountSummaryDto> {
    if (!isAccountAddress(address))
      throw new BadRequestException(
        'Not a valid Stellar account address (expected G..., 56 characters)',
      );
    let account;
    try {
      account = await this.ledger.loadAccount(address);
    } catch (err) {
      if (err instanceof LedgerUnavailableError)
        throw new ServiceUnavailableException(
          'The Stellar network could not be reached. Try again shortly',
        );
      throw err;
    }
    const balances = new Map(
      (account?.balances ?? []).map((b) => [b.assetId, b.balance]),
    );
    return {
      address,
      shortAddress: shortAddress(address),
      exists: account !== null,
      explorerUrl: this.config.accountUrl(address),
      assets: this.config.assets.map(({ id, code, issuer, native }) => {
        const balance = balances.get(id) ?? null;
        return {
          id,
          code,
          issuer,
          native,
          trusted: balance !== null,
          balance,
        };
      }),
    };
  }
}
