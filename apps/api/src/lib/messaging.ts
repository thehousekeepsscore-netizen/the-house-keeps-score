import { env } from '../env.js';
import { TEMPLATE_LANGUAGE, type OutboundMessage } from './messageTemplates.js';

// Outbound player messaging.
//
// Two channels, deliberately behind one interface:
//
//   whatsapp -> Meta WhatsApp Cloud API, sending *approved templates*.
//               Business-initiated WhatsApp messages cannot be free text:
//               outside the 24h customer-service window Meta only delivers
//               templates registered ahead of time (see messageTemplates.ts).
//               Going direct to Meta rather than through a BSP avoids the
//               per-message reseller markup.
//   sms      -> Twilio, plain text (no template system involved).
//
// Swapping in another BSP later means adding one more object here; nothing
// else in the codebase touches a provider.

export type MessageChannel = 'email' | 'sms' | 'whatsapp';

export interface MessageProvider {
  readonly name: string;
  /** Decides which contact field on a Recipient is used to address the send. */
  readonly channel: MessageChannel;
  send(to: string, message: OutboundMessage): Promise<void>;
}

/** Contact details for one player. Any field may be missing. */
export interface Recipient {
  name?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
}

// Intentionally permissive: this only guards against obviously unusable
// values, since the provider is the real authority on deliverability.
function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Normalises the free-text phone numbers we collect at profile setup into
 * E.164. Returns null when there's nothing sendable — callers must treat that
 * as "skip this player", never as an error.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Keep a leading +, drop every other non-digit (spaces, dashes, brackets).
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (hadPlus) {
    // Already country-coded. E.164 allows at most 15 digits.
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  const cc = env.MESSAGING_DEFAULT_COUNTRY_CODE.replace(/\D/g, '');

  // A number saved with the country code but no "+" (e.g. 919876543210).
  if (cc && digits.startsWith(cc) && digits.length > 10) {
    return digits.length <= 15 ? `+${digits}` : null;
  }

  // A bare national number (e.g. 9876543210) — prefix the default country.
  if (digits.length >= 8 && digits.length <= 12) {
    const full = `${cc}${digits}`;
    return full.length <= 15 ? `+${full}` : null;
  }

  return null;
}

const noopProvider: MessageProvider = {
  name: 'noop',
  channel: env.MESSAGING_CHANNEL,
  async send(to, message) {
    console.log(`[messaging:noop] -> ${to} | ${message.subject} | ${message.preview}`);
  },
};

// ---- Email: Resend (REST, no SDK dependency) ----
function createResendProvider(apiKey: string, from: string): MessageProvider {
  return {
    name: 'resend-email',
    channel: 'email',
    async send(to, message) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject: message.subject,
          html: message.html,
          text: message.preview,
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Resend responded ${res.status}: ${detail.slice(0, 400)}`);
      }
    },
  };
}

// ---- WhatsApp: Meta Cloud API (template messages) ----
function createMetaWhatsAppProvider(phoneNumberId: string, accessToken: string): MessageProvider {
  const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;

  return {
    name: 'meta-whatsapp',
    channel: 'whatsapp',
    async send(to, message) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          // Meta wants the number without the leading '+'.
          to: to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: message.templateName,
            language: { code: TEMPLATE_LANGUAGE },
            components: [
              {
                type: 'body',
                parameters: message.params.map((text) => ({ type: 'text', text })),
              },
            ],
          },
        }),
      });

      if (!res.ok) {
        // Meta's error body names the real cause (template not approved,
        // number not registered, token expired) — keep it.
        const detail = await res.text().catch(() => '');
        throw new Error(`Meta WhatsApp responded ${res.status}: ${detail.slice(0, 400)}`);
      }
    },
  };
}

// ---- SMS: Twilio (plain text) ----
function createTwilioSmsProvider(accountSid: string, authToken: string, from: string): MessageProvider {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  return {
    name: 'twilio-sms',
    channel: 'sms',
    async send(to, message) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from, Body: message.preview }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Twilio responded ${res.status}: ${detail.slice(0, 400)}`);
      }
    },
  };
}

function resolveProvider(): MessageProvider {
  if (!env.MESSAGING_ENABLED) return noopProvider;

  if (env.MESSAGING_CHANNEL === 'email') {
    const { RESEND_API_KEY, MESSAGING_FROM_EMAIL } = env;
    if (RESEND_API_KEY && MESSAGING_FROM_EMAIL) {
      return createResendProvider(RESEND_API_KEY, MESSAGING_FROM_EMAIL);
    }
    console.warn(
      '[messaging] MESSAGING_CHANNEL=email but RESEND_API_KEY / MESSAGING_FROM_EMAIL are missing — falling back to no-op.'
    );
    return noopProvider;
  }

  if (env.MESSAGING_CHANNEL === 'whatsapp') {
    const { WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN } = env;
    if (WHATSAPP_PHONE_NUMBER_ID && WHATSAPP_ACCESS_TOKEN) {
      return createMetaWhatsAppProvider(WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN);
    }
    console.warn(
      '[messaging] MESSAGING_CHANNEL=whatsapp but WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN are missing — falling back to no-op.'
    );
    return noopProvider;
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = env;
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER) {
    return createTwilioSmsProvider(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER);
  }

  console.warn('[messaging] MESSAGING_CHANNEL=sms but Twilio credentials are missing — falling back to no-op.');
  return noopProvider;
}

export const messageProvider: MessageProvider = resolveProvider();

/**
 * One-line description of what messaging will actually do, for the startup
 * summary. Which provider is live is otherwise invisible until the first
 * message either arrives or doesn't — and the most common case, a silent fall
 * back to no-op, looks identical to "sending worked".
 *
 * Never includes credentials. The from-address is not a secret.
 */
export function describeMessaging(): string {
  if (messageProvider.name === 'noop') {
    const reason = !env.MESSAGING_ENABLED
      ? 'MESSAGING_ENABLED=false'
      : `MESSAGING_CHANNEL=${env.MESSAGING_CHANNEL}, credentials missing`;
    return `NOOP — nothing will be sent (${reason})`;
  }
  return (
    `${messageProvider.name.toUpperCase()} · channel=${messageProvider.channel}` +
    (env.MESSAGING_FROM_EMAIL ? ` · from=${env.MESSAGING_FROM_EMAIL}` : '')
  );
}

/**
 * Fire-and-forget send. Never throws and never rejects: a messaging outage
 * must not roll back a buy-in approval or a settlement that already happened.
 *
 * Picks the address matching the active channel — a player with no phone still
 * gets emailed, and vice versa. Missing contact details are a skip, not an
 * error.
 */
export async function sendMessageSafely(
  recipient: Recipient,
  message: OutboundMessage,
  context: string,
  options?: {
    /**
     * Restricts this message to specific channels. Used to keep chatty
     * per-hand notices off email, where several a night reads as spam, while
     * still delivering them over SMS/WhatsApp. Omit to allow every channel.
     */
    channels?: MessageChannel[];
  }
): Promise<void> {
  if (options?.channels && !options.channels.includes(messageProvider.channel)) {
    console.log(`[messaging] skipping ${context}: not sent over ${messageProvider.channel}`);
    return;
  }

  const to =
    messageProvider.channel === 'email'
      ? normalizeEmail(recipient.email)
      : toE164(recipient.phoneNumber);

  if (!to) {
    const what = messageProvider.channel === 'email' ? 'email address' : 'phone number';
    console.log(`[messaging] skipping ${context}: no usable ${what}`);
    return;
  }

  try {
    await messageProvider.send(to, message);
    console.log(`[messaging] sent ${context} via ${messageProvider.name}`);
  } catch (err) {
    console.error(`[messaging] failed ${context}:`, err instanceof Error ? err.message : err);
  }
}
