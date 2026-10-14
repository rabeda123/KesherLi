import { Alert, Platform } from 'react-native';
import { t } from './i18n';

/** Yes/no confirmation that works on phones and on the web (where Alert buttons are not supported). */
export function confirm(message: string, okLabel = t('continue'), destructive = false): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(globalThis.confirm?.(message) ?? false);
  return new Promise((resolve) =>
    Alert.alert('', message, [
      { text: t('cancel'), style: 'cancel', onPress: () => resolve(false) },
      { text: okLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ]),
  );
}

export function inform(message: string): void {
  if (Platform.OS === 'web') globalThis.alert?.(message);
  else Alert.alert('', message);
}
