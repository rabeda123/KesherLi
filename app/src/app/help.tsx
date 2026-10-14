import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Button, Card, Chip, ErrorBox, Field, Notice, Screen, Title } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { t, tDynamic } from '../lib/i18n';
import { space } from '../lib/theme';

const REASONS = ['help', 'bullying', 'inappropriate', 'stranger', 'spam', 'other'] as const;

/** A child asks a parent for help, or anyone reports a conversation or message. */
export default function Help() {
  const { me } = useAuth();
  const { conversationId, messageId } = useLocalSearchParams<{ conversationId?: string; messageId?: string }>();
  const isReport = !!conversationId;
  const [reason, setReason] = useState<(typeof REASONS)[number]>(isReport ? 'inappropriate' : 'help');
  const [details, setDetails] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState(false);

  const send = async () => {
    setError(null);
    try {
      await api('POST', '/reports', { reason, details: details.trim() || undefined, conversationId, messageId });
      setSent(true);
    } catch (err) {
      setError(err);
    }
  };

  const title = isReport ? t('reportTitle') : t('helpTitle');
  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      <Title sub={isReport ? t('reportHint') : t('helpHint')}>{title}</Title>
      {sent ? (
        <Card>
          <Notice tone="good">✅ {t('reportSent')}</Notice>
          <Button title={t('close')} onPress={() => router.back()} />
        </Card>
      ) : (
        <Card>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {REASONS.filter((r) => isReport || me?.user.kind === 'child' || r !== 'help').map((r) => (
              <Chip key={r} label={tDynamic(`reason_${r}`)} selected={reason === r} onPress={() => setReason(r)} />
            ))}
          </View>
          <Field label={t('details')} value={details} onChangeText={setDetails} placeholder={t('helpPlaceholder')} multiline maxLength={1000} />
          <ErrorBox error={error} />
          <Button title={isReport ? t('sendReport') : t('helpSend')} onPress={send} />
        </Card>
      )}
    </Screen>
  );
}
