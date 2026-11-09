// Sends one of every Fysi email to an inbox, through the configured
// provider (Resend when RESEND_API_KEY is set), to check how they look.
//
//   pnpm mail:test you@example.com
//
// With Resend's test sender (onboarding@resend.dev) only the address that owns
// the Resend account receives mail.
import { MailService } from '../dist/mail/mail.service.js';
import { ResendMailer } from '../dist/mail/resend.mailer.js';

const to = process.argv[2];
if (!to || !to.includes('@')) {
  console.error('Usage: pnpm mail:test you@example.com');
  process.exit(1);
}
const { RESEND_API_KEY: key, MAIL_FROM: from } = process.env;
if (!key || !from) {
  console.error('Set RESEND_API_KEY and MAIL_FROM in .env first.');
  process.exit(1);
}

const config = { get: (name) => process.env[name] ?? '' };
const mail = new MailService(new ResendMailer(key, from), config);
const store = 'EcoThreads Lagos';

const emails = [
  ['Verification code', () => mail.sendVerificationCode(to, '482913', 10)],
  ['Password reset code', () => mail.sendPasswordResetCode(to, '730184', 10)],
  ['Admin invite', () => mail.sendAdminInvite(to, '615092', 60)],
  [
    'Vendor approved',
    () => mail.sendVendorDecision(to, store, 'approve', 'GOTS certificate accepted.'),
  ],
  [
    'Vendor rejected',
    () =>
      mail.sendVendorDecision(
        to,
        store,
        'reject',
        'The CAC certificate is unreadable. Upload a clearer scan.',
      ),
  ],
  [
    'Vendor suspended',
    () =>
      mail.sendVendorDecision(
        to,
        store,
        'suspend',
        'Listing products without the claimed certification.',
      ),
  ],
  ['Vendor reinstated', () => mail.sendVendorDecision(to, store, 'reinstate', null)],
];

for (const [name, send] of emails) {
  try {
    await send();
    console.log(`sent: ${name}`);
  } catch (err) {
    console.error(`failed: ${name}: ${err.message}`);
  }
  // Resend allows a few requests per second.
  await new Promise((r) => setTimeout(r, 600));
}
