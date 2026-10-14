import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Logo } from '../../components/Logo';
import { Button, Card, ErrorBox, Loading, Notice, Screen } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { t } from '../../lib/i18n';
import { font, space, useColors } from '../../lib/theme';

type Preview = { kind: 'contact' | 'admin'; familyName: string; inviterName: string | null; children: string[] };

/**
 * Invitation landing page. The person must be signed in with the phone the
 * invitation was sent to; the server enforces this on preview and accept.
 */
export default function Invite() {
  const c = useColors();
  const { token } = useLocalSearchParams<{ token: string }>();
  const { ready, token: session, me, refreshMe } = useAuth();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [accepted, setAccepted] = useState(false);

  const userId = me?.user.kind === 'adult' ? me.user.id : null;
  useEffect(() => {
    if (!session || !userId) return;
    api<Preview>('POST', '/invitations/preview', { token }).then(setPreview, setError);
  }, [session, userId, token]);

  if (!ready) return <Loading />;

  return (
    <Screen>
      <Stack.Screen options={{ title: t('invitesTitle') }} />
      <View style={{ alignItems: 'center', gap: space.md, paddingVertical: space.lg }}>
        <Logo size={80} />
        <Text style={{ fontSize: font.title, fontWeight: '800', color: c.text }}>{t('invitesTitle')}</Text>
      </View>
      {!session ? (
        <Card>
          <Notice>{t('inviteLoginFirst')}</Notice>
          <Button title={t('imParent')} onPress={() => router.replace({ pathname: '/login', params: { next: `/invite/${token}` } })} />
        </Card>
      ) : accepted ? (
        <Card>
          <Notice tone="good">✅ {t('inviteAccepted')}</Notice>
          <Button title={t('continue')} onPress={() => router.replace('/')} />
        </Card>
      ) : preview ? (
        <Card>
          <Text style={{ fontSize: font.large, fontWeight: '700', color: c.text }}>
            {t('inviteFrom', { inviter: preview.inviterName ?? '', family: preview.familyName })}
          </Text>
          <Text style={{ color: c.text, fontSize: font.body }}>
            {preview.kind === 'contact' ? t('inviteContactTo', { children: preview.children.join(', ') }) : t('inviteAdminTo')}
          </Text>
          <ErrorBox error={error} />
          <Button
            title={t('inviteAccept')}
            onPress={async () => {
              try {
                await api('POST', '/invitations/accept', { token });
                await refreshMe();
                setAccepted(true);
              } catch (err) {
                setError(err);
              }
            }}
          />
        </Card>
      ) : error ? (
        <ErrorBox error={error} />
      ) : (
        <Loading />
      )}
    </Screen>
  );
}
