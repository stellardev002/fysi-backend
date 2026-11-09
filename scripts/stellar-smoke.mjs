// End-to-end check of the Stellar integration against the public TESTNET, with
// throwaway accounts funded by Friendbot. No real money is involved.
//
//   pnpm smoke:stellar
//
// It exercises the built code in dist/: network config, Horizon lookups,
// account summaries, and a payment built, signed and submitted on chain.
import 'reflect-metadata';
import {
  Asset,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { StellarNetwork } from '../dist/config/env.validation.js';
import { HorizonLedger } from '../dist/stellar/ledger.js';
import { KeypairSigner, UnconfiguredSigner } from '../dist/stellar/signer.js';
import { StellarAccountsService } from '../dist/stellar/stellar-accounts.service.js';
import { StellarConfig } from '../dist/stellar/stellar.config.js';
import { fromStroops, toStroops } from '../dist/stellar/amounts.js';

const config = new StellarConfig({
  STELLAR_NETWORK: StellarNetwork.Testnet,
  STELLAR_ALLOW_MAINNET: false,
  STELLAR_HORIZON_URL: process.env.STELLAR_HORIZON_URL ?? '',
  STELLAR_ASSETS: 'XLM',
});
const ledger = new HorizonLedger(config.horizonUrl);
const accounts = new StellarAccountsService(config, ledger, new UnconfiguredSigner());

const step = (msg) => console.log(`- ${msg}`);
const assert = (ok, msg) => {
  if (!ok) throw new Error(`FAILED: ${msg}`);
  step(`ok: ${msg}`);
};

const fund = async (address) => {
  const res = await fetch(`https://friendbot.stellar.org?addr=${address}`);
  if (!res.ok) throw new Error(`Friendbot ${res.status}: ${await res.text()}`);
};

console.log(`Stellar smoke test on ${config.network} via ${config.horizonUrl}`);

const sender = Keypair.random();
const receiver = Keypair.random();

const before = await accounts.describe(sender.publicKey());
assert(before.exists === false, 'a fresh address does not exist on chain yet');

await Promise.all([fund(sender.publicKey()), fund(receiver.publicKey())]);
step('funded two throwaway accounts with Friendbot');

const funded = await accounts.describe(sender.publicKey());
const xlm = funded.assets.find((a) => a.id === 'XLM');
assert(funded.exists && xlm.trusted, 'the funded account exists and holds XLM');
step(`sender balance ${xlm.balance} XLM`);

const amount = '12.3456789';
const server = new Horizon.Server(config.horizonUrl);
const source = await server.loadAccount(sender.publicKey());
const tx = new TransactionBuilder(source, {
  fee: (await server.fetchBaseFee()).toString(),
  networkPassphrase: config.networkPassphrase,
})
  .addOperation(
    Operation.payment({
      destination: receiver.publicKey(),
      asset: Asset.native(),
      amount,
    }),
  )
  .setTimeout(60)
  .build();
// Stands in for the user's wallet: in the app, the customer's wallet signs.
new KeypairSigner(sender.secret()).sign(tx);
const result = await server.submitTransaction(tx);
assert(result.successful, `payment of ${amount} XLM submitted`);
step(`transaction ${config.transactionUrl(result.hash)}`);

const receiverAfter = await ledger.loadAccount(receiver.publicKey());
const received = receiverAfter.balances.find((b) => b.assetId === 'XLM').balance;
assert(
  toStroops(received) - toStroops('10000') === toStroops(amount),
  `receiver balance rose by exactly ${amount} (now ${fromStroops(toStroops(received))})`,
);

console.log('Stellar smoke test passed');
