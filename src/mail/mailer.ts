export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Sent alongside the text part when present. */
  html?: string;
  /** Images the HTML shows with `cid:<contentId>`. */
  inline?: InlineImage[];
}

export interface InlineImage {
  filename: string;
  content: Buffer;
  contentId: string;
}

export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}
