import { Stack, router } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { Card, Divider, Empty, ErrorBox, ListRow, Loading, Screen } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { t, tDynamic } from '../lib/i18n';
import { useColors } from '../lib/theme';
import { useQuery } from '../lib/useQuery';

type Notification = { id: string; kind: string; payload: Record<string, string>; createdAt: string; readAt: string | null };

const TARGET: Record<string, (p: Record<string, string>) => string> = {
  contact_request: () => '/family/requests',
  report: () => '/family/reports',
  help_request: () => '/family/reports',
  device_paired: (p) => `/family/child/${p.childId}`,
  contact_verified: () => '/family/contacts',
};

export default function Notifications() {
  const c = useColors();
  const { refreshMe } = useAuth();
  const { data, error, loading, reload } = useQuery<{ notifications: Notification[] }>('/me/notifications', ['notification.new']);

  useEffect(() => {
    api('POST', '/me/notifications/read').then(() => refreshMe(), () => {});
  }, [data, refreshMe]);

  if (loading && !data) return <Loading />;
  return (
    <Screen>
      <Stack.Screen options={{ title: t('notifications') }} />
      <ErrorBox error={error} onRetry={reload} />
      {data?.notifications.length === 0 ? (
        <Empty emoji="🔔" title={t('noNotifications')} />
      ) : (
        <Card style={{ paddingVertical: 4 }}>
          {data?.notifications.map((n, i) => (
            <View key={n.id} style={!n.readAt ? { backgroundColor: c.primarySoft, borderRadius: 10 } : undefined}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                title={tDynamic(`notif_${n.kind}`, n.payload, n.kind)}
                subtitle={formatDateTime(n.createdAt)}
                onPress={TARGET[n.kind] ? () => router.push(TARGET[n.kind]!(n.payload) as never) : undefined}
              />
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}
