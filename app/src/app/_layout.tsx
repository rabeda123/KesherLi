import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { I18nManager, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { CallOverlay } from '../components/CallOverlay';
import { AuthProvider } from '../lib/auth';
import { CallProvider } from '../lib/calls';
import { t } from '../lib/i18n';
import { useColors } from '../lib/theme';

// Hebrew is right-to-left. On phones this takes effect from the next launch
// after install; on the web the document direction is set below.
if (Platform.OS !== 'web' && !I18nManager.isRTL) {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
}

export default function RootLayout() {
  const c = useColors();
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.dir = 'rtl';
      document.documentElement.lang = 'he';
      document.title = t('appName');
    }
  }, []);

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <CallProvider>
          <StatusBar style="auto" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: c.surface },
              headerTintColor: c.primary,
              headerTitleStyle: { color: c.text, fontWeight: '700' },
              headerShadowVisible: false,
              contentStyle: { backgroundColor: c.bg },
              headerBackTitle: t('back'),
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="welcome" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="login" options={{ title: '' }} />
            <Stack.Screen name="pair" options={{ title: '' }} />
            <Stack.Screen name="profile-setup" options={{ title: '', headerBackVisible: false }} />
          </Stack>
          <CallOverlay />
        </CallProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
