import { Stack } from 'expo-router';
import { View } from 'react-native';
import { Badge, Button, Card, Divider, ErrorBox, ListRow, Loading, Screen } from '../components/ui';
import { api } from '../lib/api';
import { confirm, inform } from '../lib/dialog';
import { formatListDate } from '../lib/format';
import { errorText, t } from '../lib/i18n';
import { useQuery } from '../lib/useQuery';

type Device = { id: string; name: string; platform: string; lastSeenAt: string; current: boolean };

export default function Devices() {
  const { data, error, loading, reload } = useQuery<{ devices: Device[] }>('/me/devices');
  if (loading && !data) return <Loading />;
  return (
    <Screen>
      <Stack.Screen options={{ title: t('myDevices') }} />
      <ErrorBox error={error} onRetry={reload} />
      <Card style={{ paddingVertical: 4 }}>
        {data?.devices.map((d, i) => (
          <View key={d.id}>
            {i > 0 ? <Divider /> : null}
            <ListRow
              title={d.name}
              subtitle={t('lastSeen', { time: formatListDate(d.lastSeenAt) })}
              right={
                d.current ? (
                  <Badge label={t('thisDevice')} tone="info" />
                ) : (
                  <Button
                    title={t('disconnect')}
                    kind="danger"
                    small
                    onPress={async () => {
                      if (!(await confirm(t('disconnectConfirm'), t('disconnect'), true))) return;
                      try {
                        await api('POST', `/me/devices/${d.id}/revoke`);
                        await reload();
                      } catch (err) {
                        inform(errorText(err));
                      }
                    }}
                  />
                )
              }
            />
          </View>
        ))}
      </Card>
    </Screen>
  );
}
