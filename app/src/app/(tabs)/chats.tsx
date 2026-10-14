import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { Avatar, CountBubble, Divider, Empty, ErrorBox, Field, ListRow, Loading, styles } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { conversationColor, conversationTitle } from '../../lib/conversation';
import { formatListDate } from '../../lib/format';
import { t } from '../../lib/i18n';
import { font, space, useColors } from '../../lib/theme';
import type { ConversationSummary, Message } from '../../lib/types';
import { useQuery } from '../../lib/useQuery';

export default function Chats() {
  const c = useColors();
  const { me } = useAuth();
  const [query, setQuery] = useState('');
  const { data, error, loading, reload } = useQuery<{ conversations: ConversationSummary[] }>('/conversations', [
    'message.new',
    'message.deleted',
    'conversations.changed',
    'conversation.removed',
    'contacts.changed',
  ]);
  const search = useQuery<{ results: Message[] }>(query.trim().length >= 2 ? `/search?q=${encodeURIComponent(query.trim())}` : null);
  if (!me) return null;
  if (loading && !data) return <Loading />;

  const list = data?.conversations ?? [];
  const byId = new Map(list.map((x) => [x.id, x]));
  const searching = query.trim().length >= 2;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={[{ padding: space.lg, paddingBottom: space.sm }, styles.maxWidth]}>
        <Field value={query} onChangeText={setQuery} placeholder={t('search')} accessibilityLabel={t('search')} returnKeyType="search" />
      </View>
      <ErrorBox error={error} onRetry={reload} />
      {searching ? (
        <FlatList
          data={search.data?.results ?? []}
          keyExtractor={(m) => m.id}
          contentContainerStyle={[{ paddingHorizontal: space.lg }, styles.maxWidth]}
          ItemSeparatorComponent={Divider}
          ListEmptyComponent={search.loading ? null : <Empty emoji="🔍" title={t('noResults')} />}
          renderItem={({ item }) => {
            const conv = byId.get(item.conversationId);
            return (
              <ListRow
                title={conv ? conversationTitle(conv, me.user.id) : ''}
                subtitle={item.body ?? ''}
                right={<Text style={{ color: c.textMuted, fontSize: font.small }}>{formatListDate(item.createdAt)}</Text>}
                onPress={() => router.push(`/chat/${item.conversationId}`)}
              />
            );
          }}
        />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(x) => x.id}
          refreshControl={<RefreshControl refreshing={false} onRefresh={reload} />}
          contentContainerStyle={[{ paddingHorizontal: space.lg, flexGrow: 1 }, styles.maxWidth]}
          ItemSeparatorComponent={Divider}
          ListEmptyComponent={<Empty emoji="💬" title={t('chatsEmpty')} hint={t('chatsEmptyHint')} />}
          renderItem={({ item }) => {
            const title = conversationTitle(item, me.user.id);
            const last = item.lastMessage;
            const preview = last ? (last.body ?? t('deletedMessage')) : '';
            const mine = last?.senderId === me.user.id;
            return (
              <ListRow
                left={
                  item.kind === 'group' ? (
                    <View style={{ width: 50, height: 50, borderRadius: 25, backgroundColor: c.tealSoft, alignItems: 'center', justifyContent: 'center' }}>
                      <Ionicons name="people" size={24} color={c.teal} />
                    </View>
                  ) : (
                    <Avatar name={title} color={conversationColor(item, me.user.id)} size={50} />
                  )
                }
                title={title}
                subtitle={
                  <Text style={{ fontSize: font.small + 1, color: item.unread ? c.text : c.textMuted, fontWeight: item.unread ? '600' : '400' }} numberOfLines={1}>
                    {!item.canSend ? '🔒 ' : ''}
                    {mine ? `${t('you')}: ` : ''}
                    {preview}
                  </Text>
                }
                right={
                  <View style={{ alignItems: 'flex-end', gap: 6 }}>
                    <Text style={{ fontSize: font.small, color: item.unread ? c.teal : c.textMuted, fontWeight: item.unread ? '700' : '400' }}>
                      {formatListDate(item.lastMessageAt)}
                    </Text>
                    <CountBubble n={item.unread} />
                  </View>
                }
                onPress={() => router.push(`/chat/${item.id}`)}
              />
            );
          }}
        />
      )}
    </View>
  );
}
