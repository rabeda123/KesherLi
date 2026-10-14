import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { maskPhone } from './phone.js';

export interface SmsSender {
  readonly name: string;
  send(toE164: string, text: string): Promise<void>;
}

/**
 * Development only: writes the SMS to the server log instead of sending it.
 * loadConfig() refuses this provider when NODE_ENV=production.
 */
class ConsoleSms implements SmsSender {
  readonly name = 'console';
  constructor(private log: FastifyBaseLogger) {}
  async send(to: string, text: string) {
    this.log.warn({ to: maskPhone(to) }, `[DEV SMS — not actually sent] ${text}`);
  }
}

/** Sends SMS through Twilio's REST API. Requires TWILIO_* settings. */
class TwilioSms implements SmsSender {
  readonly name = 'twilio';
  constructor(private cfg: { accountSid: string; authToken: string; from: string }) {}
  async send(to: string, text: string) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: this.cfg.from, Body: text }),
    });
    if (!res.ok) throw new Error(`Twilio send failed with status ${res.status}`);
  }
}

export function createSmsSender(config: Config, log: FastifyBaseLogger): SmsSender {
  return config.sms.provider === 'twilio' ? new TwilioSms(config.sms) : new ConsoleSms(log);
}
