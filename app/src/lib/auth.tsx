import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setApiToken, setUnauthorizedHandler } from './api';
import { registerForPush } from './push';
import { realtime } from './realtime';
import { tokenStore } from './storage';
import type { Me } from './types';

type AuthState = {
  ready: boolean;
  token: string | null;
  me: Me | null;
  signIn: (token: string) => Promise<void>;
  signOut: (opts?: { remote?: boolean }) => Promise<void>;
  refreshMe: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  const clear = useCallback(async () => {
    realtime.stop();
    setApiToken(null);
    await tokenStore.set(null);
    setToken(null);
    setMe(null);
  }, []);

  const load = useCallback(async (tok: string) => {
    setApiToken(tok);
    const m = await api<Me>('GET', '/me');
    setMe(m);
    setToken(tok);
    realtime.start(tok);
    registerForPush().catch(() => {});
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => void clear());
    const off = realtime.subscribe((e) => {
      if (e.type === 'session.revoked') void clear();
    });
    (async () => {
      const saved = await tokenStore.get();
      if (saved) {
        try {
          await load(saved);
        } catch (err: any) {
          // Keep the session when merely offline; drop it if the server rejected it.
          if (err?.status === 401) await clear();
          else {
            setApiToken(saved);
            setToken(saved);
            realtime.start(saved);
          }
        }
      }
      setReady(true);
    })();
    return () => {
      off();
      setUnauthorizedHandler(null);
    };
  }, [clear, load]);

  const signIn = useCallback(
    async (tok: string) => {
      await tokenStore.set(tok);
      await load(tok);
    },
    [load],
  );

  const signOut = useCallback(
    async (opts?: { remote?: boolean }) => {
      if (opts?.remote !== false) await api('POST', '/auth/logout').catch(() => {});
      await clear();
    },
    [clear],
  );

  const refreshMe = useCallback(async () => {
    setMe(await api<Me>('GET', '/me'));
  }, []);

  useEffect(() => realtime.subscribe((e) => {
    // 'reconnected' also covers starting offline: the profile loads once the server is reachable.
    if (e.type === 'family.changed' || e.type === 'notification.new' || e.type === 'reconnected') refreshMe().catch(() => {});
  }), [refreshMe]);

  const value = useMemo(() => ({ ready, token, me, signIn, signOut, refreshMe }), [ready, token, me, signIn, signOut, refreshMe]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** The family the signed-in adult manages (the first one, for now). */
export function useFamily() {
  const { me } = useAuth();
  return me?.families[0] ?? null;
}
