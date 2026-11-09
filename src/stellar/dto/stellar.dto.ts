import { ApiProperty } from '@nestjs/swagger';

export class AssetDto {
  @ApiProperty({
    example: 'XLM',
    description:
      '`XLM`, or `CODE:ISSUER` for issued assets. Use this id when referring to an asset.',
  })
  id: string;

  @ApiProperty({ example: 'XLM' })
  code: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      'Issuer account; null for XLM. Always show it next to the code so users can spot lookalike assets.',
  })
  issuer: string | null;

  @ApiProperty({ example: true })
  native: boolean;
}

export class NetworkInfoDto {
  @ApiProperty({ enum: ['testnet'], example: 'testnet', description: 'Always testnet for now.' })
  network: string;

  @ApiProperty({
    example: 'Test SDF Network ; September 2015',
    description:
      'Compare with the passphrase the wallet reports. On a mismatch, show a "wrong network" state and do not ask the wallet to sign.',
  })
  networkPassphrase: string;

  @ApiProperty({ example: 'https://horizon-testnet.stellar.org' })
  horizonUrl: string;

  @ApiProperty({
    example: 'https://stellar.expert/explorer/testnet',
    description:
      'Append `/tx/{hash}` or `/account/{address}` for explorer links.',
  })
  explorerUrl: string;

  @ApiProperty({
    type: [AssetDto],
    description: 'Settlement assets the platform accepts (USDC on Stellar).',
  })
  assets: AssetDto[];

  @ApiProperty({
    nullable: true,
    example: 'GBPLATFORMWEBAUTHACCOUNTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    description:
      'The platform account, once configured (phase 2: settlement). Null until then.',
  })
  platformAccount: string | null;
}

export class AccountAssetDto extends AssetDto {
  @ApiProperty({
    example: true,
    description:
      'Whether the account can hold this asset: always true for XLM on an existing account; for issued assets, whether a trustline exists.',
  })
  trusted: boolean;

  @ApiProperty({
    nullable: true,
    example: '9999.9999900',
    description:
      'Current balance as an exact decimal string; null when not trusted or the account does not exist.',
  })
  balance: string | null;
}

export class AccountSummaryDto {
  @ApiProperty({
    example: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ',
  })
  address: string;

  @ApiProperty({ example: 'GCEZ…74JZ', description: 'Display form.' })
  shortAddress: string;

  @ApiProperty({
    example: true,
    description:
      'False when the address is valid but has never been funded, so it does not exist on the network yet.',
  })
  exists: boolean;

  @ApiProperty({
    example:
      'https://stellar.expert/explorer/testnet/account/GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ',
  })
  explorerUrl: string;

  @ApiProperty({
    type: [AccountAssetDto],
    description: 'One entry per accepted asset, in allowlist order.',
  })
  assets: AccountAssetDto[];
}
