import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, Chip, ErrorBox, Field, Loading, Notice, Screen } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth, useFamily } from '../../lib/auth';
import { t } from '../../lib/i18n';
import { font, space, useColors } from '../../lib/theme';
import { useQuery } from '../../lib/useQuery';

type Contact = { id: string; userId: string | null; displayName: string; blocked: boolean; approvals: Array<{ status: string }> };
type FamilyInfo = { children: Array<{ id: string; displayName: string }>; admins: Array<{ id: string; displayName: string | null }> };

export default function NewGroup() {
  const c = useColors();
  const family = useFamily();
  const { me } = useAuth();
  const info = useQuery<FamilyInfo>(family ? `/families/${family.id}` : null);
  const contacts = useQuery<{ contacts: Contact[] }>(family ? `/families/${family.id}/contacts` : null);
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  if (!family || !me) return null;
  if (!info.data || !contacts.data) return <Loading />;

  // Children, co-parents, and verified contacts approved for at least one
  // child. The server checks that every adult may talk with every child chosen.
  const candidates = [
    ...info.data.children.map((k) => ({ id: k.id, name: k.displayName })),
    ...info.data.admins.filter((a) => a.id !== me.user.id).map((a) => ({ id: a.id, name: a.displayName ?? '' })),
    ...contacts.data.contacts
      .filter((ct) => ct.userId && !ct.blocked && ct.approvals.some((a) => a.status === 'approved'))
      .map((ct) => ({ id: ct.userId!, name: ct.displayName })),
  ];

  const toggle = (id: string) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelected(s);
  };

  const create = async () => {
    setError(null);
    try {
      const r = await api<{ id: string }>('POST', `/families/${family.id}/groups`, { title: title.trim(), memberIds: [...selected] });
      router.replace(`/chat/${r.id}`);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: t('newGroup') }} />
      <Card>
        <Field label={t('groupTitle')} value={title} onChangeText={setTitle} placeholder={t('groupTitlePlaceholder')} maxLength={60} />
        <Text style={{ fontWeight: '700', color: c.text, fontSize: font.body }}>{t('groupMembers')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {candidates.map((p) => (
            <Chip key={p.id} label={p.name} selected={selected.has(p.id)} onPress={() => toggle(p.id)} />
          ))}
        </View>
        <Notice>{t('groupRule')}</Notice>
      </Card>
      <ErrorBox error={error} />
      <Button title={t('createGroup')} onPress={create} disabled={!title.trim() || selected.size === 0} />
    </Screen>
  );
}
