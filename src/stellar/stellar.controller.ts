import { Controller, Get, HttpStatus, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators.js';
import { ApiRoute } from '../common/api-docs.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { AccountSummaryDto, NetworkInfoDto } from './dto/stellar.dto.js';
import { StellarAccountsService } from './stellar-accounts.service.js';

const ADDRESS = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ';

@ApiTags('Stellar')
@Public()
@Controller('stellar')
export class StellarController {
  constructor(private readonly accounts: StellarAccountsService) {}

  @ApiRoute({
    summary: 'Network and accepted assets',
    path: '/api/v1/stellar/network',
    description:
      'Which Stellar network the platform runs on, the assets it accepts, and explorer links. Call it once at startup: before any wallet action, compare `networkPassphrase` with the wallet\'s network and show a "wrong network" state on a mismatch.',
    message: 'Stellar network',
    model: NetworkInfoDto,
    example: {
      network: 'testnet',
      networkPassphrase: 'Test SDF Network ; September 2015',
      horizonUrl: 'https://horizon-testnet.stellar.org',
      explorerUrl: 'https://stellar.expert/explorer/testnet',
      assets: [{ id: 'XLM', code: 'XLM', issuer: null, native: true }],
      platformAccount: null,
    },
  })
  @Get('network')
  network(): NetworkInfoDto {
    return this.accounts.networkInfo();
  }

  @RateLimit({ capacity: 20, refillPerSec: 1 / 3 })
  @ApiRoute({
    summary: 'Look up a Stellar account',
    path: '/api/v1/stellar/accounts/{address}',
    description: `Validates an address and reports, for each accepted asset, whether the account can hold it and its balance. Use it to explain problems before asking a wallet to sign: account not funded yet (\`exists: false\`), missing trustline (\`trusted: false\`), or not enough balance.

- Read-only; no wallet connection needed.
- Rate limited: 20 requests burst, then one every 3 seconds, per client.`,
    message: 'Stellar account',
    model: AccountSummaryDto,
    example: {
      address: ADDRESS,
      shortAddress: 'GCEZ…74JZ',
      exists: true,
      explorerUrl: `https://stellar.expert/explorer/testnet/account/${ADDRESS}`,
      assets: [
        {
          id: 'XLM',
          code: 'XLM',
          issuer: null,
          native: true,
          trusted: true,
          balance: '9999.9999900',
        },
      ],
    },
    errors: [
      {
        status: HttpStatus.BAD_REQUEST,
        message:
          'Not a valid Stellar account address (expected G..., 56 characters)',
        description:
          'Malformed address, bad checksum, or a muxed (M...) address.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
      {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'The Stellar network could not be reached. Try again shortly',
        description: 'Horizon is down or unreachable.',
      },
    ],
  })
  @Get('accounts/:address')
  account(@Param('address') address: string): Promise<AccountSummaryDto> {
    return this.accounts.describe(address);
  }
}
