import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, ErrorBox, Field, Screen, Title } from '../components/ui';
import { api, deviceInfo } from '../lib/api';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';

export default function Pair() {
  const { signIn } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');

  const pair = async () => {
    setError(null);
    try {
      const r = await api<{ token: string }>('POST', '/auth/pair', { code: clean, device: deviceInfo() });
      await signIn(r.token);
      router.replace('/chats');
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Screen>
      <View style={{ alignItems: 'center' }}>
        <Text style={{ fontSize: 64 }}>🔑</Text>
      </View>
      <Title sub={t('pairHint')}>{t('pairTitle')}</Title>
      <Field
        value={code}
        onChangeText={(v) => {
          const s = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
          setCode(s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s);
        }}
        placeholder={t('pairPlaceholder')}
        autoCapitalize="characters"
        autoCorrect={false}
        autoFocus
        onSubmitEditing={pair}
        style={{ fontSize: 28, letterSpacing: 6, textAlign: 'center', fontWeight: '700' }}
        accessibilityLabel={t('pairTitle')}
      />
      <ErrorBox error={error} />
      <Button title={t('pairButton')} onPress={pair} disabled={clean.length !== 8} />
    </Screen>
  );
}
