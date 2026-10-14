import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, ErrorBox, Field, Screen, Title } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth, useFamily } from '../../lib/auth';
import { t } from '../../lib/i18n';
import { radius, space, useColors } from '../../lib/theme';

export default function AddChild() {
  const c = useColors();
  const family = useFamily();
  const { refreshMe } = useAuth();
  const [name, setName] = useState('');
  const [year, setYear] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ id: string; code: string } | null>(null);
  if (!family) return null;

  const save = async () => {
    setError(null);
    try {
      const birthYear = year ? Number(year) : undefined;
      const r = await api<{ id: string }>('POST', `/families/${family.id}/children`, { displayName: name.trim(), birthYear });
      const p = await api<{ code: string }>('POST', `/families/${family.id}/children/${r.id}/pairing-code`);
      await refreshMe();
      setCreated({ id: r.id, code: p.code });
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: t('addChild') }} />
      {created ? (
        <Card>
          <Title>{t('pairingCodeTitle', { name: name.trim() })}</Title>
          <View style={{ backgroundColor: c.warmSoft, borderRadius: radius.md, padding: space.xl, alignItems: 'center' }}>
            <Text style={{ fontSize: 36, fontWeight: '900', letterSpacing: 4, color: c.text }} selectable>
              {created.code}
            </Text>
          </View>
          <Text style={{ color: c.textMuted, textAlign: 'center' }}>{t('pairingCodeHint')}</Text>
          <Button title={t('done')} onPress={() => router.replace(`/family/child/${created.id}`)} />
        </Card>
      ) : (
        <Card>
          <Field label={t('childName')} value={name} onChangeText={setName} maxLength={60} autoFocus />
          <Field
            label={`${t('birthYear')} (${t('optional')})`}
            value={year}
            onChangeText={(v) => setYear(v.replace(/\D/g, '').slice(0, 4))}
            keyboardType="number-pad"
            placeholder="2016"
          />
          <ErrorBox error={error} />
          <Button title={t('addChild')} onPress={save} disabled={!name.trim() || (!!year && year.length !== 4)} />
        </Card>
      )}
    </Screen>
  );
}
