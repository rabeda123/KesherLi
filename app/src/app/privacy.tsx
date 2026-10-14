import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { Platform, Share, Text } from 'react-native';
import { StepUp } from '../components/family';
import { Body, Button, Card, Notice, Screen, Title } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { inform } from '../lib/dialog';
import { errorText, t } from '../lib/i18n';
import { useColors } from '../lib/theme';

export default function Privacy() {
  const c = useColors();
  const { me, signOut } = useAuth();
  const [deleting, setDeleting] = useState(false);
  const isOwner = me?.families.some((f) => f.role === 'owner');

  const exportData = async () => {
    try {
      const data = await api('GET', '/me/export');
      const json = JSON.stringify(data, null, 2);
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'kesharli-export.json';
        a.click();
        URL.revokeObjectURL(url);
      } else {
        await Share.share({ message: json, title: 'kesharli-export.json' });
      }
    } catch (err) {
      inform(errorText(err));
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: t('privacy') }} />
      <Title>{t('privacy')}</Title>
      <Card>
        <Body>{t('termsSummary')}</Body>
        <Text style={{ color: c.textMuted }}>{t('e2eeNote')}</Text>
      </Card>
      <Card>
        <Button title={t('exportData')} kind="secondary" onPress={exportData} />
      </Card>
      <Card>
        {isOwner ? (
          <Notice tone="warn">{t('err_owner_must_transfer_or_delete_family')}</Notice>
        ) : deleting ? (
          <>
            <Notice tone="warn">{t('deleteAccountConfirm')}</Notice>
            <StepUp
              confirmLabel={t('deleteAccount')}
              onCancel={() => setDeleting(false)}
              onConfirm={async (proof) => {
                await api('DELETE', '/me', proof);
                await signOut({ remote: false });
                router.replace('/welcome');
              }}
            />
          </>
        ) : (
          <Button title={t('deleteAccount')} kind="danger" onPress={() => setDeleting(true)} />
        )}
      </Card>
    </Screen>
  );
}
