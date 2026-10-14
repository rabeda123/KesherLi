import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  Avatar,
  Badge,
  Body,
  Button,
  Card,
  CheckRow,
  Divider,
  Empty,
  ErrorBox,
  Field,
  ListRow,
  Loading,
  Notice,
  Screen,
  SectionTitle,
  Stat,
  Title,
  styles,
} from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth, useFamily } from '../../lib/auth';
import { formatDateTime, formatListDate } from '../../lib/format';
import { t, tDynamic } from '../../lib/i18n';
import { font, radius, space, useColors } from '../../lib/theme';
import { useQuery } from '../../lib/useQuery';

const TERMS_VERSION = '2026-10';

type Dashboard = {
  children: Array<{
    id: string;
    displayName: string;
    avatarColor: string;
    approvedContacts: number;
    activeDevices: number;
    lastSeenAt: string | null;
    quietHoursOn: boolean;
  }>;
  pendingRequests: number;
  pendingVerification: number;
  openReports: number;
  recentConversations: Array<{ id: string; kind: string; title: string | null; lastMessageAt: string; childName: string; withNames: string | null }>;
  alerts: Array<{ id: number; kind: string; createdAt: string; actorName: string | null }>;
};

export default function FamilyTab() {
  const family = useFamily();
  if (!family) return <CreateFamily />;
  return <FamilyDashboard familyId={family.id} />;
}

function CreateFamily() {
  const { refreshMe } = useAuth();
  const [name, setName] = useState('');
  const [terms, setTerms] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const create = async () => {
    setError(null);
    try {
      await api('POST', '/families', { name: name.trim(), acceptTerms: true, parentalConsent: true, termsVersion: TERMS_VERSION });
      await refreshMe();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Screen>
      <Empty emoji="🏡" title={t('noFamilyTitle')} hint={t('noFamilyHint')} />
      <Card>
        <Title sub={t('createFamilyHint')}>{t('createFamilyTitle')}</Title>
        <Field label={t('familyName')} value={name} onChangeText={setName} placeholder={t('familyNamePlaceholder')} maxLength={60} />
        <Notice>{t('termsSummary')}</Notice>
        <CheckRow label={t('acceptTerms')} checked={terms} onToggle={() => setTerms(!terms)} />
        <CheckRow label={t('parentalConsent')} checked={consent} onToggle={() => setConsent(!consent)} />
        <ErrorBox error={error} />
        <Button title={t('createFamily')} onPress={create} disabled={!name.trim() || !terms || !consent} />
      </Card>
    </Screen>
  );
}

function FamilyDashboard({ familyId }: { familyId: string }) {
  const c = useColors();
  const family = useFamily()!;
  const { data, error, loading, reload } = useQuery<Dashboard>(`/families/${familyId}/dashboard`, [
    'family.changed',
    'contacts.changed',
    'notification.new',
    'conversations.changed',
  ]);
  if (loading && !data) return <Loading />;

  return (
    <Screen>
      <ErrorBox error={error} onRetry={reload} />
      {family.isDemo ? <Notice tone="warn">{t('demoFamily')}</Notice> : null}
      <Text style={{ fontSize: font.title, fontWeight: '800', color: c.text }}>{family.name}</Text>

      {data ? (
        <>
          <View style={{ flexDirection: 'row', gap: space.md, flexWrap: 'wrap' }}>
            <Stat value={data.pendingRequests} label={t('pendingRequests')} tone={data.pendingRequests ? 'warm' : 'textMuted'} onPress={() => router.push('/family/requests')} />
            <Stat value={data.pendingVerification} label={t('pendingVerification')} tone="primary" onPress={() => router.push('/family/contacts')} />
            <Stat value={data.openReports} label={t('openReports')} tone={data.openReports ? 'danger' : 'textMuted'} onPress={() => router.push('/family/reports')} />
          </View>

          <SectionTitle
            action={family.canChangeSettings ? <Button title={t('addChild')} kind="ghost" small icon="＋" onPress={() => router.push('/family/add-child')} /> : null}
          >
            {t('children')}
          </SectionTitle>
          {data.children.length === 0 ? (
            <Card>
              <Empty emoji="🧒" title={t('addChild')}>
                {family.canChangeSettings ? <Button title={t('addChild')} onPress={() => router.push('/family/add-child')} /> : null}
              </Empty>
            </Card>
          ) : (
            data.children.map((ch) => (
              <Card key={ch.id} onPress={() => router.push(`/family/child/${ch.id}`)}>
                <View style={styles.row}>
                  <Avatar name={ch.displayName} color={ch.avatarColor} size={52} />
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={{ fontSize: font.large, fontWeight: '700', color: c.text }}>{ch.displayName}</Text>
                    <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
                      <Badge label={t('approvedContacts', { n: ch.approvedContacts })} tone="good" />
                      <Badge label={ch.activeDevices ? t('devicesCount', { n: ch.activeDevices }) : t('noDevice')} tone={ch.activeDevices ? 'info' : 'warn'} />
                      {ch.quietHoursOn ? <Badge label={`🌙 ${t('quietHours')}`} /> : null}
                    </View>
                  </View>
                  <Ionicons name="chevron-back" size={20} color={c.textMuted} />
                </View>
              </Card>
            ))
          )}

          <SectionTitle>{t('quickActions')}</SectionTitle>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
            {family.canManageContacts ? <Action icon="person-add-outline" label={t('addContact')} onPress={() => router.push('/family/add-contact')} /> : null}
            <Action icon="list-outline" label={t('manageContacts')} onPress={() => router.push('/family/contacts')} />
            {family.canManageContacts ? <Action icon="people-outline" label={t('newGroup')} onPress={() => router.push('/family/new-group')} /> : null}
            <Action icon="time-outline" label={t('auditLog')} onPress={() => router.push('/family/audit')} />
            <Action icon="flag-outline" label={t('reports')} onPress={() => router.push('/family/reports')} />
            <Action icon="options-outline" label={t('familySettings')} onPress={() => router.push('/family/settings')} />
          </View>

          <SectionTitle>{t('recentActivity')}</SectionTitle>
          <Card style={{ paddingVertical: space.sm }}>
            <Body muted style={{ fontSize: font.small }}>
              {t('recentActivityHint')}
            </Body>
            {data.recentConversations.length === 0 ? (
              <Body muted>—</Body>
            ) : (
              data.recentConversations.map((rc, i) => (
                <View key={rc.id + rc.childName}>
                  {i > 0 ? <Divider /> : null}
                  <ListRow
                    title={`${rc.childName} ${t('with')} ${rc.kind === 'group' ? rc.title : (rc.withNames ?? '—')}`}
                    subtitle={rc.kind === 'group' ? (rc.withNames ?? '') : undefined}
                    right={<Text style={{ color: c.textMuted, fontSize: font.small }}>{formatListDate(rc.lastMessageAt)}</Text>}
                  />
                </View>
              ))
            )}
          </Card>

          <SectionTitle>{t('securityAlerts')}</SectionTitle>
          <Card style={{ paddingVertical: space.sm }}>
            {data.alerts.length === 0 ? (
              <Body muted>{t('noAlerts')}</Body>
            ) : (
              data.alerts.map((a, i) => (
                <View key={a.id}>
                  {i > 0 ? <Divider /> : null}
                  <ListRow title={tDynamic(`event_${a.kind}`, undefined, a.kind)} subtitle={`${a.actorName ?? ''} · ${formatDateTime(a.createdAt)}`} />
                </View>
              ))
            )}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

function Action({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flexBasis: '30%',
        flexGrow: 1,
        minWidth: 100,
        backgroundColor: c.surface,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: c.border,
        padding: space.md,
        alignItems: 'center',
        gap: 6,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={icon} size={20} color={c.primary} />
      </View>
      <Text style={{ color: c.text, fontSize: font.small, fontWeight: '600', textAlign: 'center' }}>{label}</Text>
    </Pressable>
  );
}
