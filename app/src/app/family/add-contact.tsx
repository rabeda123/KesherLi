import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { DEFAULT_PERMISSIONS, InviteLinkBox, PermissionsEditor } from '../../components/family';
import { Button, Card, Chip, ErrorBox, Field, Loading, Notice, Screen, Title } from '../../components/ui';
import { api } from '../../lib/api';
import { useFamily } from '../../lib/auth';
import { t } from '../../lib/i18n';
import { font, space, useColors } from '../../lib/theme';
import type { Permissions } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';

type FamilyInfo = { children: Array<{ id: string; displayName: string }> };

export default function AddContact() {
  const c = useColors();
  const family = useFamily();
  const { childId } = useLocalSearchParams<{ childId?: string }>();
  const { data } = useQuery<FamilyInfo>(family ? `/families/${family.id}` : null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set(childId ? [childId] : []));
  const [perms, setPerms] = useState<Permissions>(DEFAULT_PERMISSIONS);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ status: string; inviteLink: string | null; phone: string } | null>(null);
  if (!family) return null;
  if (!data) return <Loading />;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const save = async () => {
    setError(null);
    try {
      const r = await api<{ status: string; inviteLink: string | null; contactId: string; phone: string }>('POST', `/families/${family.id}/contacts`, {
        displayName: name.trim(),
        phone,
        children: [...selected].map((id) => ({ childId: id, ...perms })),
      });
      setResult({ status: r.status, inviteLink: r.inviteLink, phone: r.phone });
    } catch (err) {
      setError(err);
    }
  };

  if (result) {
    return (
      <Screen>
        <Stack.Screen options={{ title: t('addContact') }} />
        <Card>
          <Title>✅ {t('addContactDone')}</Title>
          {result.inviteLink ? <InviteLinkBox link={result.inviteLink} phone={result.phone} /> : <Notice tone="good">{t('approvedNow')}</Notice>}
          <Button title={t('done')} onPress={() => router.back()} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: t('addContact') }} />
      <Notice>{t('noAddressBook')}</Notice>
      <Card>
        <Field label={t('contactName')} value={name} onChangeText={setName} placeholder={t('contactNamePlaceholder')} maxLength={60} />
        <Field label={t('contactPhone')} value={phone} onChangeText={setPhone} placeholder={t('phonePlaceholder')} keyboardType="phone-pad" />
      </Card>
      <Card>
        <Text style={{ fontWeight: '700', color: c.text, fontSize: font.body }}>{t('forWhichChildren')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {data.children.map((ch) => (
            <Chip key={ch.id} label={ch.displayName} selected={selected.has(ch.id)} onPress={() => toggle(ch.id)} />
          ))}
        </View>
        <Text style={{ fontWeight: '700', color: c.text, fontSize: font.body }}>{t('whatAllowed')}</Text>
        <PermissionsEditor value={perms} onChange={setPerms} />
        <Text style={{ fontSize: font.small, color: c.textMuted }}>{t('permsSoon')}</Text>
      </Card>
      <ErrorBox error={error} />
      <Button title={t('addContact')} onPress={save} disabled={!name.trim() || phone.replace(/\D/g, '').length < 9 || selected.size === 0} />
    </Screen>
  );
}
