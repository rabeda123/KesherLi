import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect, Tabs } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { Loading } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { t } from '../../lib/i18n';
import { realtime } from '../../lib/realtime';
import { font, useColors } from '../../lib/theme';

function OfflineBar() {
  const c = useColors();
  const [connected, setConnected] = useState(realtime.connected);
  const [show, setShow] = useState(false);
  useEffect(() => realtime.onConnectionChange(setConnected), []);
  // Avoid flashing the bar during the first connection.
  useEffect(() => {
    if (connected) return setShow(false);
    const id = setTimeout(() => setShow(true), 2500);
    return () => clearTimeout(id);
  }, [connected]);
  if (!show) return null;
  return (
    <View style={{ backgroundColor: c.warmSoft, paddingVertical: 6, paddingHorizontal: 12 }} accessibilityLiveRegion="polite">
      <Text style={{ color: c.warm, fontSize: font.small, textAlign: 'center', fontWeight: '600' }}>{t('offline')}</Text>
    </View>
  );
}

export default function TabsLayout() {
  const c = useColors();
  const { ready, token, me } = useAuth();
  if (!ready) return <Loading />;
  if (!token) return <Redirect href="/welcome" />;
  if (!me) return <Loading />;
  const isChild = me.user.kind === 'child';

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <OfflineBar />
      <Tabs
        screenOptions={{
          headerStyle: { backgroundColor: c.surface },
          headerTitleStyle: { color: c.text, fontWeight: '800', fontSize: 20 },
          headerShadowVisible: false,
          headerTitleAlign: 'center',
          tabBarActiveTintColor: c.teal,
          tabBarInactiveTintColor: c.textMuted,
          tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.border, ...(Platform.OS === 'web' ? { height: 64, paddingTop: 6, paddingBottom: 8 } : {}) },
          tabBarLabelStyle: { fontSize: 12, fontWeight: '600', lineHeight: 16 },
          sceneStyle: { backgroundColor: c.bg },
        }}
      >
        <Tabs.Screen
          name="family"
          options={{
            title: t('tabFamily'),
            href: isChild ? null : '/family',
            tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="chats"
          options={{
            title: t('tabChats'),
            tabBarIcon: ({ color, size }) => <Ionicons name="chatbubbles-outline" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="people"
          options={{
            title: t('tabPeople'),
            tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: isChild ? t('tabMe') : t('tabSettings'),
            tabBarBadge: me.unreadNotifications || undefined,
            tabBarIcon: ({ color, size }) => <Ionicons name={isChild ? 'happy-outline' : 'settings-outline'} color={color} size={size} />,
          }}
        />
      </Tabs>
    </View>
  );
}
