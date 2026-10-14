import type { WebSocket } from 'ws';

export type RealtimeEvent =
  | { type: 'message.new'; conversationId: string; message: unknown }
  | { type: 'message.deleted'; conversationId: string; messageId: string }
  | { type: 'conversation.receipt'; conversationId: string; userId: string; lastDeliveredAt: string | null; lastReadAt: string | null }
  | { type: 'conversation.removed'; conversationId: string }
  | { type: 'conversations.changed' }
  | { type: 'contacts.changed' }
  | { type: 'family.changed'; familyId: string }
  | { type: 'notification.new'; notification: unknown }
  | { type: 'session.revoked' }
  | { type: 'call.incoming'; call: unknown }
  | { type: 'call.updated'; call: unknown }
  | { type: 'call.signal'; callId: string; signal: unknown };

type Conn = { socket: WebSocket; userId: string; deviceId: string };

/**
 * In-process registry of connected sockets. Events are hints that tell the
 * app to refresh; every refresh goes through the authorized REST API, so a
 * missed event never grants access. To run several server instances, fan
 * events out through Postgres LISTEN/NOTIFY or Redis pub/sub.
 */
export class RealtimeHub {
  private byUser = new Map<string, Set<Conn>>();

  add(conn: Conn): () => void {
    let set = this.byUser.get(conn.userId);
    if (!set) this.byUser.set(conn.userId, (set = new Set()));
    set.add(conn);
    return () => {
      set.delete(conn);
      if (set.size === 0) this.byUser.delete(conn.userId);
    };
  }

  publish(userIds: Iterable<string>, event: RealtimeEvent): void {
    const data = JSON.stringify(event);
    for (const id of new Set(userIds)) {
      for (const c of this.byUser.get(id) ?? []) {
        if (c.socket.readyState === c.socket.OPEN) c.socket.send(data);
      }
    }
  }

  /** Sends to one device only (call signaling must reach the device in the call). */
  publishToDevice(userId: string, deviceId: string, event: RealtimeEvent): void {
    const data = JSON.stringify(event);
    for (const c of this.byUser.get(userId) ?? []) {
      if (c.deviceId === deviceId && c.socket.readyState === c.socket.OPEN) c.socket.send(data);
    }
  }

  isOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  /** Closes the sockets of a revoked device (or all devices of a user). */
  disconnect(filter: { deviceId?: string; userId?: string }): void {
    const payload = JSON.stringify({ type: 'session.revoked' } satisfies RealtimeEvent);
    for (const set of this.byUser.values()) {
      for (const c of set) {
        if ((filter.deviceId && c.deviceId === filter.deviceId) || (filter.userId && c.userId === filter.userId)) {
          if (c.socket.readyState === c.socket.OPEN) c.socket.send(payload);
          c.socket.close(4001, 'session revoked');
        }
      }
    }
  }
}
