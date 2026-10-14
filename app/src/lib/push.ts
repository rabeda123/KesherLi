import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';

/**
 * Registers this device for push notifications. Works only on a physical
 * device in an EAS build with an EAS project id and push credentials; in
 * every other case it quietly does nothing and the app relies on its live
 * connection while open.
 */
export async function registerForPush(): Promise<void> {
  if (Platform.OS === 'web' || !Device.isDevice) return;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return;
  const existing = await Notifications.getPermissionsAsync();
  const status = existing.granted ? 'granted' : (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'הודעות', importance: Notifications.AndroidImportance.HIGH });
  }
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  await api('PUT', '/me/push-token', { token: token.data });
}
