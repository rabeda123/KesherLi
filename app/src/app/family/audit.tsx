import { Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Button, Card, Divider, Empty, ErrorBox, ListRow, Loading, Screen } from '../../components/ui';
import { api } from '../../lib/api';
import { useFamily } from '../../lib/auth';
import { formatDateTime } from '../../lib/format';
import { t, tDynamic } from '../../lib/i18n';
import { useQuery } from '../../lib/useQuery';

type Event = { id: number; kind: string; createdAt: string; actorName: string | null; metadata: Record<string, unknown> };

export default function Audit() {
  const family = useFamily();
  const { data, error, loading, reload } = useQuery<{ events: Event[] }>(family ? `/families/${family.id}/audit` : null);
  const [older, setOlder] = useState<Event[]>([]);
  const [done, setDone] = useState(false);
  if (!family) return null;
  if (loading && !data) return <Loading />;
  const events = [...(data?.events ?? []), ...older];

  const more = async () => {
    const last = events[events.length - 1];
    if (!last) return;
    const r = await api<{ events: Event[] }>('GET', `/families/${family.id}/audit?before=${last.id}`);
    setOlder((o) => [...o, ...r.events]);
    if (r.events.length < 50) setDone(true);
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: t('auditLog') }} />
      <ErrorBox error={error} onRetry={reload} />
      {events.length === 0 ? (
        <Empty emoji="🗒️" title={t('auditEmpty')} />
      ) : (
        <Card style={{ paddingVertical: 4 }}>
          {events.map((e, i) => (
            <View key={e.id}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                title={tDynamic(`event_${e.kind}`, undefined, e.kind) + (typeof e.metadata?.name === 'string' ? ` · ${e.metadata.name}` : '')}
                subtitle={`${e.actorName ?? '—'} · ${formatDateTime(e.createdAt)}`}
              />
            </View>
          ))}
        </Card>
      )}
      {events.length >= 50 && !done ? <Button title={t('loadOlder')} kind="ghost" onPress={more} /> : null}
    </Screen>
  );
}
