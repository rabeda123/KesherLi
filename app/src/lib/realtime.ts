import { API_URL } from './api';

export type RealtimeEvent = { type: string; [k: string]: any };
type Listener = (e: RealtimeEvent) => void;

/**
 * One WebSocket per signed-in session, reconnecting with backoff. Events are
 * hints to refresh data through the REST API; after a reconnect, listeners
 * receive a synthetic "reconnected" event so screens can resync.
 */
class Realtime {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private listeners = new Set<Listener>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  connected = false;
  private connectedListeners = new Set<(c: boolean) => void>();

  start(token: string) {
    if (this.token === token && this.ws) return;
    this.stop();
    this.token = token;
    this.open();
  }

  stop() {
    this.token = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setConnected(false);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onConnectionChange(fn: (c: boolean) => void): () => void {
    this.connectedListeners.add(fn);
    return () => this.connectedListeners.delete(fn);
  }

  private setConnected(c: boolean) {
    if (this.connected === c) return;
    this.connected = c;
    this.connectedListeners.forEach((fn) => fn(c));
  }

  private emit(e: RealtimeEvent) {
    this.listeners.forEach((fn) => fn(e));
  }

  private open() {
    const token = this.token;
    if (!token) return;
    const ws = new WebSocket(API_URL.replace(/^http/, 'ws') + '/ws');
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
    ws.onmessage = (msg) => {
      let e: RealtimeEvent;
      try {
        e = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (e.type === 'ready') {
        const wasRetry = this.retry > 0;
        this.retry = 0;
        this.setConnected(true);
        if (wasRetry) this.emit({ type: 'reconnected' });
        return;
      }
      this.emit(e);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setConnected(false);
      if (ev.code === 4001) {
        // Session revoked or invalid: stop and let the app sign out.
        this.emit({ type: 'session.revoked' });
        this.token = null;
        return;
      }
      if (!this.token) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.open(), delay);
    };
  }
}

export const realtime = new Realtime();
