import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { InviteLinkBox, StatusBadge } from '../../components/family';
import { Badge, Body, Button, Card, Empty, ErrorBox, Loading, Screen, styles } from '../../components/ui';
import { api } from '../../lib/api';
import { useFamily } from '../../lib/auth';
import { confirm, inform } from '../../lib/dialog';
import { displayPhone } from '../../lib/format';
import { errorText, t } from '../../lib/i18n';
import { font, space, useColors } from '../../lib/theme';
import type { ApprovalStatus } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';

type Contact = {
  id: string;
  displayName: string;
  phone: string;
  verified: boolean;
  blocked: boolean;
  inviteExpiresAt: string | null;
  approvals: Array<{ id: string; childName: string; status: ApprovalStatus }>;
};

export default function Contacts() {
  const c = useColors();
  const family = useFamily();
  const { data, error, loading, reload } = useQuery<{ contacts: Contact[] }>(family ? `/families/${family.id}/contacts` : null, ['contacts.changed']);
  const [links, setLinks] = useState<Record<string, string>>({});
  if (!family) return null;
  if (loading && !data) return <Loading />;
  const can = family.canManageContacts;

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
    } catch (err) {
      inform(errorText(err));
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: t('manageContacts') }} />
      <ErrorBox error={error} onRetry={reload} />
      {can ? <Button title={t('addContact')} icon="＋" onPress={() => router.push('/family/add-contact')} /> : null}
      {data?.contacts.length === 0 ? <Empty emoji="📇" title={t('peopleEmpty')} /> : null}
      {data?.contacts.map((ct) => {
        const visible = ct.approvals.filter((a) => a.status !== 'removed');
        return (
          <Card key={ct.id}>
            <View style={styles.rowBetween}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontSize: font.large, fontWeight: '700', color: c.text }}>{ct.displayName}</Text>
                <Body muted>
                  {displayPhone(ct.phone)} · {ct.verified ? t('verified') : t('notVerified')}
                </Body>
              </View>
              {ct.blocked ? <Badge label={t('blocked')} tone="bad" /> : null}
            </View>
            {visible.length ? (
              <View style={{ gap: space.sm }}>
                {visible.map((a) => (
                  <View key={a.id} style={styles.rowBetween}>
                    <Body>{a.childName}</Body>
                    <StatusBadge status={a.status} />
                  </View>
                ))}
              </View>
            ) : null}
            {links[ct.id] ? <InviteLinkBox link={links[ct.id]!} phone={ct.phone} /> : null}
            {can ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {ct.blocked ? (
                  <Button title={t('unblock')} kind="secondary" small onPress={() => run(() => api('POST', `/contacts/${ct.id}/unblock`))} />
                ) : (
                  <>
                    {!ct.verified && ct.approvals.some((a) => a.status === 'pending_verification') ? (
                      <Button
                        title={t('newInviteLink')}
                        kind="secondary"
                        small
                        onPress={() =>
                          run(async () => {
                            const r = await api<{ inviteLink: string }>('POST', `/contacts/${ct.id}/invitation`);
                            setLinks((l) => ({ ...l, [ct.id]: r.inviteLink }));
                          })
                        }
                      />
                    ) : null}
                    <Button
                      title={t('block')}
                      kind="danger"
                      small
                      onPress={async () => {
                        if (await confirm(t('blockConfirm', { name: ct.displayName }), t('block'), true)) {
                          await run(() => api('POST', `/contacts/${ct.id}/block`, {}));
                        }
                      }}
                    />
                  </>
                )}
              </View>
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}
