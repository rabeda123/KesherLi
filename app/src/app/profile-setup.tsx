import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Button, ErrorBox, Field, Screen, Title } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';

export default function ProfileSetup() {
  const { refreshMe } = useAuth();
  const { next } = useLocalSearchParams<{ next?: string }>();
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);

  const save = async () => {
    try {
      await api('PATCH', '/me', { displayName: name.trim() });
      await refreshMe();
      router.replace((next && next.startsWith('/') ? next : '/') as never);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Screen>
      <Title sub={t('nameHint')}>{t('nameTitle')}</Title>
      <Field value={name} onChangeText={setName} placeholder={t('namePlaceholder')} autoFocus maxLength={60} onSubmitEditing={save} />
      <ErrorBox error={error} />
      <Button title={t('continue')} onPress={save} disabled={!name.trim()} />
    </Screen>
  );
}
