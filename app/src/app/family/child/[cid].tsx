import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { DEFAULT_PERMISSIONS, PermissionsEditor, StatusBadge, StepUp } from '../../../components/family';
import { Avatar, Badge, Body, Button, Card, Divider, ErrorBox, Field, ListRow, Loading, Notice, Screen, SectionTitle, ToggleRow, styles } from '../../../components/ui';
import { api } from '../../../lib/api';
import { useAuth, useFamily } from '../../../lib/auth';
import { confirm, inform } from '../../../lib/dialog';
import { displayPhone, formatListDate, hhmmToMinutes, minutesToHHMM } from '../../../lib/format';
import { errorText, t } from '../../../lib/i18n';
import { font, radius, space, useColors } from '../../../lib/theme';
import type { ApprovalStatus, Permissions } from '../../../lib/types';
import { useQuery } from '../../../lib/useQuery';

type ChildDetail = {
  child: {
    id: string;
    displayName: string;
    avatarColor: string;
    birthYear: number | null;
    allowContactRequests: boolean;
    allowProfileEdit: boolean;
    readReceipts: boolean;
    quietStartMin: number | null;
    quietEndMin: number | null;
  };
  contacts: Array<{ approvalId: string; contactId: string; displayName: string; phone: string; verified: boolean; status: ApprovalStatus } & Permissions>;
  devices: Array<{ id: string; name: string; platform: string; lastSeenAt: string }>;
};

export default function ChildScreen() {
  const { cid } = useLocalSearchParams<{ cid: string }>();
  const c = useColors();
  const family = useFamily();
  const { refreshMe } = useAuth();
  const path = family ? `/families/${family.id}/children/${cid}` : null;
  const { data, error, loading, reload } = useQuery<ChildDetail>(path, ['contacts.changed', 'family.changed']);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [perms, setPerms] = useState<Permissions>(DEFAULT_PERMISSIONS);
  const [quietFrom, setQuietFrom] = useState('');
  const [quietTo, setQuietTo] = useState('');
  const [removing, setRemoving] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    if (!data) return;
    setQuietFrom(data.child.quietStartMin !== null ? minutesToHHMM(data.child.quietStartMin) : '');
    setQuietTo(data.child.quietEndMin !== null ? minutesToHHMM(data.child.quietEndMin) : '');
  }, [data]);

  if (!family) return null;
  if (loading && !data) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} onRetry={reload} /></Screen>;
  const { child } = data;
  const canSettings = family.canChangeSettings;
  const canContacts = family.canManageContacts;

  const patch = async (body: Record<string, unknown>) => {
    setActionError(null);
    try {
      await api('PATCH', `/families/${family.id}/children/${cid}`, body);
      await reload();
    } catch (err) {
      setActionError(err);
    }
  };

  const saveQuiet = async () => {
    const s = quietFrom ? hhmmToMinutes(quietFrom) : null;
    const e = quietTo ? hhmmToMinutes(quietTo) : null;
    if ((quietFrom && s === null) || (quietTo && e === null) || (s === null) !== (e === null)) {
      setActionError({ code: 'invalid_input' });
      return;
    }
    await patch({ quietStartMin: s, quietEndMin: e });
  };

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
      <Stack.Screen options={{ title: child.displayName }} />
      <View style={[styles.row, { gap: space.lg }]}>
        <Avatar name={child.displayName} color={child.avatarColor} size={68} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: font.title, fontWeight: '800', color: c.text }}>{child.displayName}</Text>
          {child.birthYear ? <Body muted>{child.birthYear}</Body> : null}
        </View>
      </View>
      <ErrorBox error={actionError} />

      <SectionTitle action={canContacts ? <Button title={t('addContact')} kind="ghost" small icon="＋" onPress={() => router.push({ pathname: '/family/add-contact', params: { childId: cid } })} /> : null}>
        {t('childContacts', { name: child.displayName })}
      </SectionTitle>
      <Card style={{ paddingVertical: space.xs }}>
        {data.contacts.length === 0 ? <Body muted>{t('peopleEmpty')}</Body> : null}
        {data.contacts.map((ct, i) => (
          <View key={ct.approvalId}>
            {i > 0 ? <Divider /> : null}
            <ListRow
              title={ct.displayName}
              subtitle={`${displayPhone(ct.phone)} · ${ct.verified ? t('verified') : t('notVerified')}`}
              right={<StatusBadge status={ct.status} />}
              onPress={
                canContacts && ct.status !== 'blocked'
                  ? () => {
                      setEditing(editing === ct.approvalId ? null : ct.approvalId);
                      setPerms({ canMessage: ct.canMessage, canSendMedia: ct.canSendMedia, canVoice: ct.canVoice, canCall: ct.canCall });
                    }
                  : undefined
              }
            />
            {editing === ct.approvalId ? (
              <View style={{ gap: space.md, paddingBottom: space.md }}>
                <Text style={{ fontWeight: '700', color: c.text }}>{t('whatAllowed')}</Text>
                <PermissionsEditor value={perms} onChange={setPerms} />
                <Text style={{ fontSize: font.small, color: c.textMuted }}>{t('permsSoon')}</Text>
                <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
                  <Button title={t('save')} small onPress={() => run(() => api('PATCH', `/approvals/${ct.approvalId}`, perms)).then(() => setEditing(null))} />
                  {ct.status !== 'removed' ? (
                    <Button
                      title={t('remove')}
                      kind="secondary"
                      small
                      onPress={async () => {
                        if (await confirm(t('removeConfirm', { name: ct.displayName, child: child.displayName }), t('remove'), true)) {
                          await run(() => api('POST', `/approvals/${ct.approvalId}/remove`));
                          setEditing(null);
                        }
                      }}
                    />
                  ) : null}
                  <Button
                    title={t('block')}
                    kind="danger"
                    small
                    onPress={async () => {
                      if (await confirm(t('blockConfirm', { name: ct.displayName }), t('block'), true)) {
                        await run(() => api('POST', `/contacts/${ct.contactId}/block`, {}));
                        setEditing(null);
                      }
                    }}
                  />
                </View>
              </View>
            ) : null}
          </View>
        ))}
      </Card>

      <SectionTitle>{t('childSettings')}</SectionTitle>
      <Card>
        <ToggleRow label={t('allowContactRequests')} value={child.allowContactRequests} disabled={!canSettings} onChange={(v) => patch({ allowContactRequests: v })} />
        <Divider />
        <ToggleRow label={t('allowProfileEdit')} value={child.allowProfileEdit} disabled={!canSettings} onChange={(v) => patch({ allowProfileEdit: v })} />
        <Divider />
        <ToggleRow
          label={t('readReceipts')}
          hint={t('readReceiptsHint', { name: child.displayName })}
          value={child.readReceipts}
          disabled={!canSettings}
          onChange={(v) => patch({ readReceipts: v })}
        />
        <Divider />
        <Text style={{ fontSize: font.body, color: c.text }}>🌙 {t('quietHours')}</Text>
        <Text style={{ fontSize: font.small, color: c.textMuted }}>{t('quietHoursHint')}</Text>
        <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}>
            <Field label={t('quietFrom')} value={quietFrom} onChangeText={setQuietFrom} placeholder="21:00" editable={canSettings} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label={t('quietTo')} value={quietTo} onChangeText={setQuietTo} placeholder="07:00" editable={canSettings} />
          </View>
        </View>
        {canSettings ? <Button title={t('save')} kind="secondary" small onPress={saveQuiet} /> : null}
      </Card>

      <SectionTitle>{t('devices')}</SectionTitle>
      <Card>
        {data.devices.length === 0 ? <Body muted>{t('noDevice')}</Body> : null}
        {data.devices.map((d) => (
          <ListRow
            key={d.id}
            title={d.name}
            subtitle={t('lastSeen', { time: formatListDate(d.lastSeenAt) })}
            right={
              canSettings ? (
                <Button
                  title={t('disconnect')}
                  kind="danger"
                  small
                  onPress={async () => {
                    if (await confirm(t('disconnectConfirm'), t('disconnect'), true)) {
                      await run(() => api('POST', `/families/${family.id}/children/${cid}/devices/${d.id}/revoke`));
                    }
                  }}
                />
              ) : undefined
            }
          />
        ))}
        {pairing ? (
          <View style={{ backgroundColor: c.warmSoft, borderRadius: radius.md, padding: space.lg, alignItems: 'center', gap: space.sm }}>
            <Text style={{ color: c.text, fontWeight: '700' }}>{t('pairingCodeTitle', { name: child.displayName })}</Text>
            <Text style={{ fontSize: 34, fontWeight: '900', letterSpacing: 4, color: c.text }} selectable>
              {pairing.code}
            </Text>
            <Text style={{ color: c.textMuted, fontSize: font.small, textAlign: 'center' }}>{t('pairingCodeHint')}</Text>
          </View>
        ) : null}
        {canSettings ? (
          <Button
            title={t('connectDevice')}
            kind="secondary"
            onPress={async () => {
              try {
                setPairing(await api('POST', `/families/${family.id}/children/${cid}/pairing-code`));
              } catch (err) {
                inform(errorText(err));
              }
            }}
          />
        ) : null}
      </Card>

      {family.role === 'owner' ? (
        <Card>
          {removing ? (
            <>
              <Notice tone="warn">{t('removeChild')}?</Notice>
              <StepUp
                confirmLabel={t('removeChild')}
                onCancel={() => setRemoving(false)}
                onConfirm={async (proof) => {
                  await api('DELETE', `/families/${family.id}/children/${cid}`, proof);
                  await refreshMe();
                  router.back();
                }}
              />
            </>
          ) : (
            <Button title={t('removeChild')} kind="danger" onPress={() => setRemoving(true)} />
          )}
        </Card>
      ) : null}
      {!canSettings ? <Badge label={t('err_missing_permission')} /> : null}
    </Screen>
  );
}
