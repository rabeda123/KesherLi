import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Avatar, Button, Card, CountBubble, Divider, ErrorBox, Field, ListRow, Screen, styles } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { confirm } from '../../lib/dialog';
import { displayPhone, inviteTokenFrom } from '../../lib/format';
import { t } from '../../lib/i18n';
import { font, space, useColors } from '../../lib/theme';

export default function Settings() {
  const c = useColors();
  const { me, refreshMe, signOut } = useAuth();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState<unknown>(null);
  if (!me) return null;
  const isChild = me.user.kind === 'child';
  const canEditName = !isChild || me.child?.allowProfileEdit;

  const saveName = async () => {
    try {
      await api('PATCH', '/me', { displayName: name.trim() });
      await refreshMe();
      setEditing(false);
    } catch (err) {
      setError(err);
    }
  };

  const chevron = <Ionicons name="chevron-back" size={18} color={c.textMuted} />;
  const icon = (name: keyof typeof Ionicons.glyphMap, color = c.primary) => <Ionicons name={name} size={22} color={color} />;

  return (
    <Screen>
      <Card>
        <View style={styles.row}>
          <Avatar name={me.user.displayName} color={me.user.avatarColor} size={64} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: font.title, fontWeight: '800', color: c.text }}>{me.user.displayName}</Text>
            <Text style={{ color: c.textMuted }}>{me.user.phone ? displayPhone(me.user.phone) : me.child?.familyName}</Text>
          </View>
        </View>
        {editing ? (
          <>
            <Field value={name} onChangeText={setName} maxLength={60} autoFocus label={t('editName')} />
            <ErrorBox error={error} />
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Button title={t('save')} onPress={saveName} disabled={!name.trim()} />
              </View>
              <View style={{ flex: 1 }}>
                <Button title={t('cancel')} kind="secondary" onPress={() => setEditing(false)} />
              </View>
            </View>
          </>
        ) : canEditName ? (
          <Button
            title={t('editName')}
            kind="secondary"
            small
            onPress={() => {
              setName(me.user.displayName ?? '');
              setEditing(true);
            }}
          />
        ) : null}
      </Card>

      <Card style={{ paddingVertical: space.xs }}>
        <ListRow left={icon('notifications-outline')} title={t('notifications')} right={<View style={styles.row}><CountBubble n={me.unreadNotifications} />{chevron}</View>} onPress={() => router.push('/notifications')} />
        {isChild ? (
          <>
            <Divider />
            <ListRow left={icon('person-add-outline', c.teal)} title={t('requestContact')} right={chevron} onPress={() => router.push('/request-contact')} />
            <Divider />
            <ListRow left={icon('help-buoy-outline', c.warm)} title={t('helpTitle')} right={chevron} onPress={() => router.push('/help')} />
          </>
        ) : (
          <>
            <Divider />
            <ListRow left={icon('phone-portrait-outline')} title={t('myDevices')} right={chevron} onPress={() => router.push('/devices')} />
            <Divider />
            <ListRow left={icon('shield-checkmark-outline')} title={t('privacy')} right={chevron} onPress={() => router.push('/privacy')} />
          </>
        )}
      </Card>

      {!isChild ? (
        <Card>
          <Text style={{ fontWeight: '700', color: c.text }}>{t('haveInvite')}</Text>
          <Field value={link} onChangeText={setLink} placeholder={t('invitePaste')} autoCapitalize="none" autoCorrect={false} />
          <Button title={t('inviteOpen')} kind="secondary" small disabled={!inviteTokenFrom(link)} onPress={() => router.push(`/invite/${inviteTokenFrom(link)}`)} />
        </Card>
      ) : null}

      <Button
        title={t('logout')}
        kind="danger"
        onPress={async () => {
          if (await confirm(t('logoutConfirm'), t('logout'), true)) {
            await signOut();
            router.replace('/welcome');
          }
        }}
      />
      <Text style={{ color: c.textMuted, fontSize: font.small, textAlign: 'center' }}>{t('appName')} 0.1.0</Text>
    </Screen>
  );
}
