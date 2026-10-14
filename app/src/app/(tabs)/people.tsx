import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, View } from 'react-native';
import { Avatar, Button, Divider, Empty, ErrorBox, ListRow, Loading, styles } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { errorText, t, tDynamic } from '../../lib/i18n';
import { inform } from '../../lib/dialog';
import { space, useColors } from '../../lib/theme';
import type { Person } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';

export default function People() {
  const c = useColors();
  const { me } = useAuth();
  const [opening, setOpening] = useState<string | null>(null);
  const { data, error, loading, reload } = useQuery<{ people: Person[] }>('/me/reachable', ['contacts.changed', 'family.changed']);
  if (!me) return null;
  if (loading && !data) return <Loading />;
  const isChild = me.user.kind === 'child';

  const open = async (p: Person) => {
    setOpening(p.id);
    try {
      const r = await api<{ id: string }>('POST', '/conversations/direct', { userId: p.id });
      router.push(`/chat/${r.id}`);
    } catch (err) {
      inform(errorText(err));
    } finally {
      setOpening(null);
    }
  };

  const requestButton =
    isChild && me.child?.allowContactRequests ? (
      <View style={{ paddingVertical: space.md }}>
        <Button title={t('requestContact')} kind="secondary" icon="➕" onPress={() => router.push('/request-contact')} />
      </View>
    ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ErrorBox error={error} onRetry={reload} />
      <FlatList
        data={data?.people ?? []}
        keyExtractor={(p) => p.id}
        contentContainerStyle={[{ paddingHorizontal: space.lg, flexGrow: 1 }, styles.maxWidth]}
        ItemSeparatorComponent={Divider}
        ListHeaderComponent={requestButton}
        ListEmptyComponent={<Empty emoji="🤝" title={t('peopleEmpty')} hint={isChild ? t('peopleEmptyChildHint') : undefined} />}
        renderItem={({ item }) => (
          <ListRow
            left={<Avatar name={item.displayName} color={item.avatarColor} />}
            title={item.displayName ?? '—'}
            subtitle={tDynamic(`relation_${item.relation}`, { family: item.familyName })}
            onPress={opening ? undefined : () => open(item)}
          />
        )}
      />
    </View>
  );
}
