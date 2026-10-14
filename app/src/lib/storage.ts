import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * The session token lives in the platform keychain/keystore on phones.
 * On the web there is no equivalent, so it falls back to localStorage —
 * acceptable for development and demos; a production web client should use
 * an httpOnly cookie instead.
 */
export const tokenStore = {
  async get(): Promise<string | null> {
    if (Platform.OS === 'web') {
      try {
        return globalThis.localStorage?.getItem('kesharli.token') ?? null;
      } catch {
        return null;
      }
    }
    return SecureStore.getItemAsync('kesharli.token');
  },
  async set(token: string | null): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        if (token) globalThis.localStorage?.setItem('kesharli.token', token);
        else globalThis.localStorage?.removeItem('kesharli.token');
      } catch {
        /* storage unavailable: the session lasts until reload */
      }
      return;
    }
    if (token) await SecureStore.setItemAsync('kesharli.token', token);
    else await SecureStore.deleteItemAsync('kesharli.token');
  },
};
