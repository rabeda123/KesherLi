import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Logo } from '../components/Logo';
import { Button, Field, styles } from '../components/ui';
import { useAuth } from '../lib/auth';
import { inviteTokenFrom } from '../lib/format';
import { t } from '../lib/i18n';
import { font, radius, space, useColors } from '../lib/theme';

export default function Welcome() {
  const c = useColors();
  const { token } = useAuth();
  const [showInvite, setShowInvite] = useState(false);
  const [link, setLink] = useState('');
  if (token) return <Redirect href="/" />;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={[{ flex: 1, padding: space.xl, justifyContent: 'center', gap: space.xxl }, styles.maxWidth]}>
        <View style={{ alignItems: 'center', gap: space.md }}>
          <Logo size={108} />
          <Text style={{ fontSize: 40, fontWeight: '800', color: c.text, letterSpacing: -0.5 }}>{t('appName')}</Text>
          <Text style={{ fontSize: font.large, color: c.textMuted, textAlign: 'center', lineHeight: 26 }}>{t('tagline')}</Text>
        </View>

        <View style={{ gap: space.md }}>
          <Choice emoji="👋" title={t('imParent')} hint={t('imParentHint')} onPress={() => router.push('/login')} tone="primary" />
          <Choice emoji="🧒" title={t('imChild')} hint={t('imChildHint')} onPress={() => router.push('/pair')} tone="warm" />
        </View>

        <View style={{ gap: space.sm }}>
          {showInvite ? (
            <>
              <Field value={link} onChangeText={setLink} placeholder={t('invitePaste')} autoCapitalize="none" autoCorrect={false} />
              <Button
                title={t('inviteOpen')}
                kind="secondary"
                disabled={!inviteTokenFrom(link)}
                onPress={() => router.push(`/invite/${inviteTokenFrom(link)}`)}
              />
            </>
          ) : (
            <Button title={t('haveInvite')} kind="ghost" onPress={() => setShowInvite(true)} />
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

function Choice({ emoji, title, hint, onPress, tone }: { emoji: string; title: string; hint: string; onPress: () => void; tone: 'primary' | 'warm' }) {
  // Fixed, saturated colors so white text stays readable in light and dark mode.
  const bg = tone === 'primary' ? '#2F6FC9' : '#D9612E';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.lg,
        backgroundColor: bg,
        borderRadius: radius.lg,
        padding: space.lg,
        opacity: pressed ? 0.88 : 1,
      })}
    >
      <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 28 }}>{emoji}</Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: '#fff', fontSize: font.large, fontWeight: '800' }}>{title}</Text>
        <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: font.small + 1 }}>{hint}</Text>
      </View>
    </Pressable>
  );
}
