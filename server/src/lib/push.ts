import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';

export type PushMessage = { to: string; title: string; body: string; data?: Record<string, unknown> };

export interface PushSender {
  readonly enabled: boolean;
  send(messages: PushMessage[]): Promise<void>;
}

class NoPush implements PushSender {
  readonly enabled = false;
  async send() {}
}

/**
 * Expo push service, which relays to APNs and FCM. The app must be built
 * with EAS and have push credentials configured for real devices to receive
 * notifications. https://docs.expo.dev/push-notifications/overview/
 */
class ExpoPush implements PushSender {
  readonly enabled = true;
  constructor(
    private accessToken: string | undefined,
    private log: FastifyBaseLogger,
  ) {}
  async send(messages: PushMessage[]) {
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100).map((m) => ({ ...m, sound: 'default' }));
      try {
        const res = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
          },
          body: JSON.stringify(chunk),
        });
        if (!res.ok) this.log.error({ status: res.status }, 'expo push failed');
      } catch (err) {
        this.log.error({ err }, 'expo push failed');
      }
    }
  }
}

export function createPushSender(config: Config, log: FastifyBaseLogger): PushSender {
  return config.push.provider === 'expo' ? new ExpoPush(config.push.accessToken, log) : new NoPush();
}
