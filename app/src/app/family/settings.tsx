import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { InviteLinkBox, StepUp } from '../../components/family';
import { Avatar, Badge, Body, Button, Card, Chip, Divider, ErrorBox, Field, ListRow, Loading, Notice, Screen, SectionTitle, ToggleRow } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth, useFamily } from '../../lib/auth';
import { confirm, inform } from '../../lib/dialog';
import { displayPhone } from '../../lib/format';
import { errorText, t } from '../../lib/i18n';
import { font, space, useColors } from '../../lib/theme';
import { useQuery } from '../../lib/useQuery';

type Admin = {
  id: string;
  displayName: string | null;
  avatarColor: string;
  role: 'owner' | 'admin';
  canManageContacts: boolean;
  canApproveRequests: boolean;
  canChangeSettings: boolean;
};
type FamilyInfo = {
  family: { id: string; name: string };
  admins: Admin[];
  pendingAdminInvites: Array<{ id: string; phone: string }>;
  retention: { messageRetentionDays: number | null };
};
type AdminPerms = Pick<Admin, 'canManageContacts' | 'canApproveRequests' | 'canChangeSettings'>;

const RETENTION_OPTIONS: Array<number | null> = [null, 30, 90, 365];

export default function FamilySettings() {
  const c = useColors();
  const family = useFamily();
  const { me, refreshMe } = useAuth();
  const { data, error, loading, reload } = useQuery<FamilyInfo>(family ? `/families/${family.id}` : null, ['family.changed']);
  const [name, setName] = useState('');
  const [invPhone, setInvPhone] = useState('');
  const [invPerms, setInvPerms] = useState<AdminPerms>({ canManageContacts: true, canApproveRequests: true, canChangeSettings: false });
  const [invite, setInvite] = useState<{ link: string; phone: string } | null>(null);
  const [stepUp, setStepUp] = useState<null | { kind: 'transfer'; userId: string } | { kind: 'delete' }>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    if (data) setName(data.family.name);
  }, [data]);

  if (!family || !me) return null;
  if (loading && !data) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} onRetry={reload} /></Screen>;
  const isOwner = family.role === 'owner';

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await reload();
      await refreshMe();
    } catch (err) {
      setActionError(err);
    }
  };

  const perms = (a: AdminPerms, onChange?: (p: AdminPerms) => void) => (
    <View style={{ gap: 0 }}>
      {(['canManageContacts', 'canApproveRequests', 'canChangeSettings'] as const).map((k) => (
        <ToggleRow key={k} label={t(k)} value={a[k]} disabled={!onChange} onChange={(v) => onChange?.({ ...a, [k]: v })} />
      ))}
    </View>
  );

  return (
    <Screen>
      <Stack.Screen options={{ title: t('familySettings') }} />
      <ErrorBox error={actionError} />

      <Card>
        <Field label={t('familyName')} value={name} onChangeText={setName} maxLength={60} editable={family.canChangeSettings} />
        {family.canChangeSettings ? (
          <Button title={t('save')} kind="secondary" small disabled={!name.trim() || name === data.family.name} onPress={() => act(() => api('PATCH', `/families/${family.id}`, { name: name.trim() }))} />
        ) : null}
      </Card>

      <SectionTitle>{t('coparents')}</SectionTitle>
      {data.admins.map((a) => (
        <Card key={a.id}>
          <ListRow
            left={<Avatar name={a.displayName} color={a.avatarColor} />}
            title={`${a.displayName ?? '—'}${a.id === me.user.id ? ` (${t('you')})` : ''}`}
            right={<Badge label={a.role === 'owner' ? t('owner') : t('admin')} tone={a.role === 'owner' ? 'info' : 'neutral'} />}
          />
          {a.role === 'admin' ? (
            <>
              {perms(a, isOwner ? (p) => act(() => api('PATCH', `/families/${family.id}/admins/${a.id}`, p)) : undefined)}
              <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
                {isOwner ? (
                  <>
                    <Button title={t('transferOwnership')} kind="secondary" small onPress={() => setStepUp({ kind: 'transfer', userId: a.id })} />
                    <Button
                      title={t('removeCoparent')}
                      kind="danger"
                      small
                      onPress={async () => {
                        if (await confirm(`${t('removeCoparent')} ${a.displayName}?`, t('removeCoparent'), true)) {
                          await act(() => api('DELETE', `/families/${family.id}/admins/${a.id}`));
                        }
                      }}
                    />
                  </>
                ) : a.id === me.user.id ? (
                  <Button
                    title={t('leaveFamily')}
                    kind="danger"
                    small
                    onPress={async () => {
                      if (await confirm(`${t('leaveFamily')}?`, t('leaveFamily'), true)) {
                        try {
                          await api('DELETE', `/families/${family.id}/admins/${a.id}`);
                          await refreshMe();
                          router.replace('/');
                        } catch (err) {
                          inform(errorText(err));
                        }
                      }
                    }}
                  />
                ) : null}
              </View>
              {stepUp?.kind === 'transfer' && stepUp.userId === a.id ? (
                <>
                  <Notice tone="warn">{t('transferConfirm', { name: a.displayName ?? '' })}</Notice>
                  <StepUp
                    confirmLabel={t('transferOwnership')}
                    onCancel={() => setStepUp(null)}
                    onConfirm={async (proof) => {
                      await api('POST', `/families/${family.id}/transfer-ownership`, { userId: a.id, ...proof });
                      setStepUp(null);
                      await reload();
                      await refreshMe();
                    }}
                  />
                </>
              ) : null}
            </>
          ) : null}
        </Card>
      ))}

      {data.pendingAdminInvites.length ? (
        <Card>
          <Text style={{ fontWeight: '700', color: c.text }}>{t('pendingInvites')}</Text>
          {data.pendingAdminInvites.map((i) => (
            <Body key={i.id} muted>
              {displayPhone(i.phone)}
            </Body>
          ))}
        </Card>
      ) : null}

      {isOwner ? (
        <Card>
          <Text style={{ fontWeight: '700', color: c.text, fontSize: font.body }}>{t('inviteCoparent')}</Text>
          {invite ? (
            <>
              <InviteLinkBox link={invite.link} phone={invite.phone} />
              <Button title={t('done')} kind="ghost" onPress={() => setInvite(null)} />
            </>
          ) : (
            <>
              <Field value={invPhone} onChangeText={setInvPhone} placeholder={t('phonePlaceholder')} keyboardType="phone-pad" label={t('contactPhone')} />
              {perms(invPerms, setInvPerms)}
              <Button
                title={t('inviteCoparent')}
                disabled={invPhone.replace(/\D/g, '').length < 9}
                onPress={() =>
                  act(async () => {
                    const r = await api<{ link: string }>('POST', `/families/${family.id}/admins/invite`, { phone: invPhone, permissions: invPerms });
                    setInvite({ link: r.link, phone: invPhone });
                    setInvPhone('');
                  })
                }
              />
            </>
          )}
        </Card>
      ) : null}

      <SectionTitle>{t('retention')}</SectionTitle>
      <Card>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {RETENTION_OPTIONS.map((d) => (
            <Chip
              key={String(d)}
              label={d === null ? t('retentionForever') : t('retentionDays', { n: d })}
              selected={data.retention.messageRetentionDays === d}
              onPress={() => (family.canChangeSettings ? act(() => api('PUT', `/families/${family.id}/retention`, { messageRetentionDays: d })) : undefined)}
            />
          ))}
        </View>
      </Card>

      {isOwner ? (
        <>
          <Divider />
          <Card>
            {stepUp?.kind === 'delete' ? (
              <>
                <Notice tone="warn">{t('deleteFamilyConfirm')}</Notice>
                <StepUp
                  confirmLabel={t('deleteFamily')}
                  onCancel={() => setStepUp(null)}
                  onConfirm={async (proof) => {
                    await api('DELETE', `/families/${family.id}`, proof);
                    await refreshMe();
                    router.replace('/');
                  }}
                />
              </>
            ) : (
              <Button title={t('deleteFamily')} kind="danger" onPress={() => setStepUp({ kind: 'delete' })} />
            )}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
