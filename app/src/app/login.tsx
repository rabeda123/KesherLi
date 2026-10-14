import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, ErrorBox, Field, Notice, Screen, Title } from '../components/ui';
import { api, deviceInfo } from '../lib/api';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';
import { font, space, useColors } from '../lib/theme';

export default function Login() {
  const c = useColors();
  const { signIn } = useAuth();
  const { next } = useLocalSearchParams<{ next?: string }>();
  const [phone, setPhone] = useState('');
  const [challenge, setChallenge] = useState<{ id: string; devCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);

  const request = async () => {
    setError(null);
    try {
      const r = await api<{ challengeId: string; devCode?: string }>('POST', '/auth/otp/request', { phone });
      setChallenge({ id: r.challengeId, devCode: r.devCode });
      setCode('');
    } catch (err) {
      setError(err);
    }
  };

  const verify = async () => {
    if (!challenge) return;
    setError(null);
    try {
      const r = await api<{ token: string; needsProfile: boolean }>('POST', '/auth/otp/verify', {
        challengeId: challenge.id,
        code,
        device: deviceInfo(),
      });
      await signIn(r.token);
      const dest = next && next.startsWith('/') ? next : '/';
      if (r.needsProfile) router.replace({ pathname: '/profile-setup', params: { next: dest } });
      else router.replace(dest as never);
    } catch (err) {
      setError(err);
    }
  };

  if (!challenge) {
    return (
      <Screen>
        <Title sub={t('phoneHint')}>{t('phoneTitle')}</Title>
        <Field
          value={phone}
          onChangeText={setPhone}
          placeholder={t('phonePlaceholder')}
          keyboardType="phone-pad"
          autoComplete="tel"
          textContentType="telephoneNumber"
          autoFocus
          onSubmitEditing={request}
          style={{ fontSize: font.large, letterSpacing: 1, textAlign: 'center' }}
        />
        <ErrorBox error={error} />
        <Button title={t('sendCode')} onPress={request} disabled={phone.replace(/\D/g, '').length < 9} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title sub={t('codeHint', { phone })}>{t('codeTitle')}</Title>
      {challenge.devCode ? (
        <Notice tone="warn">
          {t('devCode', { code: challenge.devCode })}
          {'\n'}
          {t('devCodeNote')}
        </Notice>
      ) : null}
      <Field
        value={code}
        onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
        placeholder="••••••"
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        autoFocus
        onSubmitEditing={verify}
        style={{ fontSize: 28, letterSpacing: 10, textAlign: 'center' }}
        accessibilityLabel={t('codeTitle')}
      />
      <ErrorBox error={error} />
      <Button title={t('verify')} onPress={verify} disabled={code.length !== 6} />
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: space.md }}>
        <Button title={t('resend')} kind="ghost" small onPress={request} />
        <Button title={t('changeNumber')} kind="ghost" small onPress={() => setChallenge(null)} />
      </View>
      <Text style={{ color: c.textMuted, fontSize: font.small, textAlign: 'center' }}>{t('e2eeNote')}</Text>
    </Screen>
  );
}
