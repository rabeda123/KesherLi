import { Stack } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { DEFAULT_PERMISSIONS, InviteLinkBox, PermissionsEditor } from '../../components/family';
import { Body, Button, Card, Empty, ErrorBox, Loading, Screen } from '../../components/ui';
import { api } from '../../lib/api';
import { useFamily } from '../../lib/auth';
import { inform } from '../../lib/dialog';
import { displayPhone, formatListDate } from '../../lib/format';
import { errorText, t } from '../../lib/i18n';
import { font, space, useColors } from '../../lib/theme';
import type { Permissions } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';

type Request = { id: string; childName: string; contactName: string; phone: string; note: string | null; updatedAt: string };

export default function Requests() {
  const c = useColors();
  const family = useFamily();
  const { data, error, loading, reload } = useQuery<{ requests: Request[] }>(family ? `/families/${family.id}/requests` : null, [
    'notification.new',
    'contacts.changed',
  ]);
  const [perms, setPerms] = useState<Record<string, Permissions>>({});
  const [approved, setApproved] = useState<Array<{ name: string; link: string; phone: string }>>([]);
  if (!family) return null;
  if (loading && !data) return <Loading />;

  const decide = async (r: Request, decision: 'approve' | 'reject') => {
    try {
      const res = await api<{ inviteLink: string | null }>('POST', `/approvals/${r.id}/decision`, {
        decision,
        permissions: perms[r.id] ?? DEFAULT_PERMISSIONS,
      });
      if (res.inviteLink) setApproved((a) => [...a, { name: r.contactName, link: res.inviteLink!, phone: r.phone }]);
      await reload();
    } catch (err) {
      inform(errorText(err));
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: t('pendingRequests') }} />
      <ErrorBox error={error} onRetry={reload} />
      {approved.map((a) => (
        <Card key={a.link}>
          <Text style={{ fontWeight: '700', color: c.text }}>✅ {a.name}</Text>
          <InviteLinkBox link={a.link} phone={a.phone} />
        </Card>
      ))}
      {data?.requests.length === 0 ? <Empty emoji="📭" title={t('noRequests')} /> : null}
      {data?.requests.map((r) => (
        <Card key={r.id}>
          <Text style={{ fontSize: font.large, fontWeight: '700', color: c.text }}>{t('requestFrom', { child: r.childName, contact: r.contactName })}</Text>
          <Body muted>
            {displayPhone(r.phone)} · {formatListDate(r.updatedAt)}
          </Body>
          {r.note ? <Body>"{r.note}"</Body> : null}
          <Text style={{ fontWeight: '700', color: c.text }}>{t('whatAllowed')}</Text>
          <PermissionsEditor value={perms[r.id] ?? DEFAULT_PERMISSIONS} onChange={(p) => setPerms((s) => ({ ...s, [r.id]: p }))} />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Button title={t('approve')} onPress={() => decide(r, 'approve')} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title={t('reject')} kind="secondary" onPress={() => decide(r, 'reject')} />
            </View>
          </View>
        </Card>
      ))}
    </Screen>
  );
}
