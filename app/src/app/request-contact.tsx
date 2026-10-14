import { Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { StatusBadge } from '../components/family';
import { Button, Card, Divider, ErrorBox, Field, ListRow, Notice, Screen, SectionTitle, Title } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';
import type { ApprovalStatus } from '../lib/types';
import { useQuery } from '../lib/useQuery';

export default function RequestContact() {
  const { me } = useAuth();
  const mine = useQuery<{ requests: Array<{ id: string; displayName: string; status: ApprovalStatus }> }>('/me/contact-requests', ['contacts.changed']);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState(false);
  const enabled = me?.child?.allowContactRequests;

  const send = async () => {
    setError(null);
    try {
      await api('POST', '/me/contact-requests', { displayName: name.trim(), phone, note: note.trim() || undefined });
      setSent(true);
      setName('');
      setPhone('');
      setNote('');
      await mine.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: t('requestTitle') }} />
      <Title sub={t('requestHint')}>{t('requestTitle')}</Title>
      {!enabled ? (
        <Notice tone="warn">{t('requestsDisabled')}</Notice>
      ) : (
        <Card>
          {sent ? <Notice tone="good">✅ {t('requestSent')}</Notice> : null}
          <Field label={t('requestWho')} value={name} onChangeText={setName} placeholder="יואב" maxLength={60} />
          <Field label={t('contactPhone')} value={phone} onChangeText={setPhone} placeholder={t('phonePlaceholder')} keyboardType="phone-pad" />
          <Field label={`${t('requestNote')} (${t('optional')})`} value={note} onChangeText={setNote} placeholder={t('requestNotePlaceholder')} maxLength={200} />
          <ErrorBox error={error} />
          <Button title={t('requestSend')} onPress={send} disabled={!name.trim() || phone.replace(/\D/g, '').length < 9} />
        </Card>
      )}
      {mine.data?.requests.length ? (
        <>
          <SectionTitle>{t('myRequests')}</SectionTitle>
          <Card style={{ paddingVertical: 4 }}>
            {mine.data.requests.map((r, i) => (
              <View key={r.id}>
                {i > 0 ? <Divider /> : null}
                <ListRow title={r.displayName} right={<StatusBadge status={r.status} />} />
              </View>
            ))}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
