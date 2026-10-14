import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar, ErrorBox, Loading } from '../../components/ui';
import { ApiError, api, newClientId } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useCalls } from '../../lib/calls';
import { conversationColor, conversationTitle } from '../../lib/conversation';
import { confirm, inform } from '../../lib/dialog';
import { formatDayHeader, formatTime, sameDay } from '../../lib/format';
import { errorText, t } from '../../lib/i18n';
import { realtime } from '../../lib/realtime';
import { font, radius, space, useColors } from '../../lib/theme';
import type { Member, Message } from '../../lib/types';

type Detail = { id: string; kind: 'direct' | 'group'; title: string | null; familyId: string; canSend: boolean; canCall: boolean; members: Member[] };
type Outgoing = { clientId: string; body: string; createdAt: string; status: 'sending' | 'failed' };
type Row = { type: 'msg'; m: Message } | { type: 'out'; o: Outgoing } | { type: 'day'; key: string; label: string };

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { me } = useAuth();
  const calls = useCalls();
  const myId = me?.user.id ?? '';
  const [detail, setDetail] = useState<Detail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [outbox, setOutbox] = useState<Outgoing[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [text, setText] = useState('');
  const lastReadSent = useRef<string | null>(null);
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const loadDetail = useCallback(async () => {
    try {
      setDetail(await api<Detail>('GET', `/conversations/${id}`));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  const merge = useCallback((incoming: Message[]) => {
    setMessages((prev) => {
      const map = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) map.set(m.id, m);
      return [...map.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    });
    // A message that arrived from the server is no longer pending.
    const ids = new Set(incoming.map((m) => m.clientId));
    setOutbox((prev) => prev.filter((o) => !ids.has(o.clientId)));
  }, []);

  useEffect(() => {
    (async () => {
      await loadDetail();
      try {
        const r = await api<{ messages: Message[]; hasMore: boolean }>('GET', `/conversations/${id}/messages?limit=50`);
        merge(r.messages);
        setHasMore(r.hasMore);
      } catch (err) {
        setError(err);
      }
    })();
  }, [id, loadDetail, merge]);

  const deliver = useCallback(
    async (o: Outgoing) => {
      setOutbox((prev) => prev.map((x) => (x.clientId === o.clientId ? { ...x, status: 'sending' } : x)));
      try {
        const r = await api<{ message: Message }>('POST', `/conversations/${id}/messages`, { clientId: o.clientId, body: o.body });
        merge([r.message]);
      } catch (err) {
        if (err instanceof ApiError && err.status === 0) {
          // Offline: keep it queued; it is retried when the connection returns.
          setOutbox((prev) => prev.map((x) => (x.clientId === o.clientId ? { ...x, status: 'failed' } : x)));
        } else {
          setOutbox((prev) => prev.filter((x) => x.clientId !== o.clientId));
          inform(errorText(err));
          void loadDetail();
        }
      }
    },
    [id, merge, loadDetail],
  );

  useEffect(
    () =>
      realtime.subscribe((e) => {
        if (e.type === 'message.new' && e.conversationId === id) merge([e.message]);
        else if (e.type === 'message.deleted' && e.conversationId === id)
          setMessages((prev) => prev.map((m) => (m.id === e.messageId ? { ...m, body: null, deletedAt: new Date().toISOString() } : m)));
        else if (e.type === 'conversation.receipt' && e.conversationId === id)
          setDetail((d) =>
            d ? { ...d, members: d.members.map((m) => (m.id === e.userId ? { ...m, lastDeliveredAt: e.lastDeliveredAt, lastReadAt: e.lastReadAt } : m)) } : d,
          );
        else if (e.type === 'conversation.removed' && e.conversationId === id) {
          router.back();
        } else if (e.type === 'contacts.changed' || e.type === 'conversations.changed') void loadDetail();
        else if (e.type === 'reconnected') {
          // Catch up on anything missed while offline, then flush the outbox.
          const newest = messagesRef.current[messagesRef.current.length - 1];
          api<{ messages: Message[] }>('GET', `/conversations/${id}/messages${newest ? `?after=${newest.id}&limit=100` : ''}`)
            .then((r) => merge(r.messages))
            .catch(() => {});
          void loadDetail();
          outboxRef.current.filter((o) => o.status === 'failed').forEach((o) => void deliver(o));
        }
      }),
    [id, merge, loadDetail, deliver],
  );

  // Mark the newest message from someone else as read.
  useEffect(() => {
    const lastOther = [...messages].reverse().find((m) => m.senderId !== myId);
    if (!lastOther || lastReadSent.current === lastOther.id) return;
    lastReadSent.current = lastOther.id;
    api('POST', `/conversations/${id}/read`, { messageId: lastOther.id }).catch(() => {});
  }, [messages, id, myId]);

  const loadOlder = async () => {
    if (!hasMore || loadingOlder || messages.length === 0) return;
    setLoadingOlder(true);
    try {
      const r = await api<{ messages: Message[]; hasMore: boolean }>('GET', `/conversations/${id}/messages?before=${messages[0]!.id}&limit=50`);
      merge(r.messages);
      setHasMore(r.hasMore);
    } finally {
      setLoadingOlder(false);
    }
  };

  const send = () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    const o: Outgoing = { clientId: newClientId(), body, createdAt: new Date().toISOString(), status: 'sending' };
    setOutbox((prev) => [...prev, o]);
    void deliver(o);
  };

  const others = useMemo(() => (detail?.members ?? []).filter((m) => m.id !== myId && !m.leftAt), [detail, myId]);
  const nameOf = useMemo(() => new Map((detail?.members ?? []).map((m) => [m.id, m])), [detail]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    let prev: string | null = null;
    const push = (iso: string, row: Row) => {
      if (!prev || !sameDay(prev, iso)) out.push({ type: 'day', key: 'day-' + iso, label: formatDayHeader(iso) });
      prev = iso;
      out.push(row);
    };
    for (const m of messages) push(m.createdAt, { type: 'msg', m });
    for (const o of outbox) push(o.createdAt, { type: 'out', o });
    return out.reverse(); // inverted list: newest first
  }, [messages, outbox]);

  const tick = (m: Message) => {
    if (others.length === 0) return '✓';
    const at = m.createdAt;
    const read = others.every((o) => o.lastReadAt && o.lastReadAt >= at);
    const delivered = others.every((o) => o.lastDeliveredAt && o.lastDeliveredAt >= at);
    return read ? 'read' : delivered ? '✓✓' : '✓';
  };

  const onLongPress = async (m: Message) => {
    if (m.deletedAt) return;
    if (m.senderId === myId) {
      if (await confirm(t('deleteMessage') + '?', t('deleteMessage'), true)) {
        api('DELETE', `/conversations/${id}/messages/${m.id}`).catch((err) => inform(errorText(err)));
      }
    } else {
      router.push({ pathname: '/help', params: { conversationId: id, messageId: m.id } });
    }
  };

  const call = (kind: 'audio' | 'video') => calls.startCall(id, kind).catch((err) => inform(errorText(err)));

  if (!me) return null;
  if (!detail && !error) return <Loading />;
  const title = detail ? conversationTitle(detail, myId) : '';

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              {detail?.kind === 'direct' ? <Avatar name={title} color={conversationColor(detail, myId)} size={34} /> : null}
              <View>
                <Text style={{ fontSize: font.large, fontWeight: '700', color: c.text }} numberOfLines={1}>
                  {title}
                </Text>
                {detail?.kind === 'group' ? (
                  <Text style={{ fontSize: font.small, color: c.textMuted }} numberOfLines={1}>
                    {detail.members.filter((m) => !m.leftAt).map((m) => (m.id === myId ? t('you') : m.displayName)).join(', ')}
                  </Text>
                ) : null}
              </View>
            </View>
          ),
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.sm }}>
              {detail?.canCall ? (
                <>
                  <Pressable onPress={() => call('video')} accessibilityLabel={t('callVideo')} hitSlop={10}>
                    <Ionicons name="videocam-outline" size={25} color={c.teal} />
                  </Pressable>
                  <Pressable onPress={() => call('audio')} accessibilityLabel={t('callAudio')} hitSlop={10}>
                    <Ionicons name="call-outline" size={23} color={c.teal} />
                  </Pressable>
                </>
              ) : null}
              <Pressable onPress={() => router.push({ pathname: '/help', params: { conversationId: id } })} accessibilityLabel={t('report')} hitSlop={10}>
                <Ionicons name="flag-outline" size={22} color={c.textMuted} />
              </Pressable>
            </View>
          ),
        }}
      />
      <ErrorBox error={error} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <FlatList
          inverted
          data={rows}
          keyExtractor={(r) => (r.type === 'msg' ? r.m.id : r.type === 'out' ? r.o.clientId : r.key)}
          contentContainerStyle={{ padding: space.md, gap: 4 }}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.2}
          ListFooterComponent={loadingOlder ? <ActivityIndicator color={c.primary} /> : null}
          renderItem={({ item, index }) => {
            if (item.type === 'day') {
              return (
                <View style={{ alignItems: 'center', marginVertical: space.sm }}>
                  <Text style={{ backgroundColor: c.surfaceAlt, color: c.textMuted, fontSize: font.small, paddingHorizontal: 12, paddingVertical: 4, borderRadius: radius.pill, overflow: 'hidden' }}>
                    {item.label}
                  </Text>
                </View>
              );
            }
            if (item.type === 'out') {
              return (
                <Bubble mine body={item.o.body} time={formatTime(item.o.createdAt)}>
                  <Pressable onPress={item.o.status === 'failed' ? () => void deliver(item.o) : undefined}>
                    <Text style={{ fontSize: 11, color: item.o.status === 'failed' ? c.danger : c.textMuted }}>
                      {item.o.status === 'failed' ? t('failedTap') : '🕓'}
                    </Text>
                  </Pressable>
                </Bubble>
              );
            }
            const m = item.m;
            const mine = m.senderId === myId;
            const sender = nameOf.get(m.senderId);
            // In an inverted list the previous message in time is the next row.
            const prevRow = rows[index + 1];
            const showName = detail?.kind === 'group' && !mine && !(prevRow?.type === 'msg' && prevRow.m.senderId === m.senderId);
            const status = mine ? tick(m) : null;
            return (
              <Pressable onLongPress={() => onLongPress(m)} delayLongPress={350}>
                <Bubble
                  mine={mine}
                  body={m.body ?? t('deletedMessage')}
                  deleted={!!m.deletedAt}
                  time={formatTime(m.createdAt)}
                  name={showName ? (sender?.displayName ?? '') : undefined}
                  nameColor={sender?.avatarColor}
                >
                  {status ? (
                    <Text style={{ fontSize: 11, color: status === 'read' ? c.primary : c.textMuted, fontWeight: '700' }} accessibilityLabel={status === 'read' ? 'נקרא' : status === '✓✓' ? 'נמסר' : 'נשלח'}>
                      {status === 'read' ? '✓✓' : status}
                    </Text>
                  ) : null}
                </Bubble>
              </Pressable>
            );
          }}
        />
        {detail?.canSend ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, padding: space.sm, backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.border }}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={t('messagePlaceholder')}
              placeholderTextColor={c.textMuted}
              multiline
              maxLength={4000}
              accessibilityLabel={t('messagePlaceholder')}
              onKeyPress={(e) => {
                // Enter sends on the web; Shift+Enter adds a line.
                const ne = e.nativeEvent as { key: string; shiftKey?: boolean };
                if (Platform.OS === 'web' && ne.key === 'Enter' && !ne.shiftKey) {
                  (e as unknown as { preventDefault: () => void }).preventDefault();
                  send();
                }
              }}
              style={{
                flex: 1,
                maxHeight: 120,
                minHeight: 44,
                backgroundColor: c.bg,
                borderRadius: 22,
                paddingHorizontal: space.lg,
                paddingVertical: 11,
                fontSize: font.body,
                color: c.text,
                ...(Platform.OS === 'web' ? { textAlign: 'right' as const, outlineStyle: 'none' as never } : {}),
              }}
            />
            <Pressable
              onPress={send}
              disabled={!text.trim()}
              accessibilityRole="button"
              accessibilityLabel={t('send')}
              style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: text.trim() ? c.teal : c.border, alignItems: 'center', justifyContent: 'center' }}
            >
              {/* The arrow points toward the reading direction's end (left in Hebrew). */}
              <Ionicons name="send" size={20} color="#fff" style={{ transform: [{ scaleX: -1 }] }} />
            </Pressable>
          </View>
        ) : detail ? (
          <View style={{ padding: space.lg, backgroundColor: c.surfaceAlt, alignItems: 'center' }}>
            <Text style={{ color: c.textMuted }}>🔒 {t('cannotSend')}</Text>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Bubble({
  mine,
  body,
  time,
  name,
  nameColor,
  deleted,
  children,
}: {
  mine: boolean;
  body: string;
  time: string;
  name?: string;
  nameColor?: string;
  deleted?: boolean;
  children?: React.ReactNode;
}) {
  const c = useColors();
  return (
    <View
      style={{
        // As in other Hebrew chat apps, my messages sit on the left (the end side in RTL).
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: '82%',
        backgroundColor: mine ? c.bubbleMine : c.bubbleOther,
        borderRadius: 18,
        ...(mine ? { borderTopEndRadius: 6 } : { borderTopStartRadius: 6 }),
        paddingHorizontal: 12,
        paddingTop: 7,
        paddingBottom: 5,
        borderWidth: mine ? 0 : 1,
        borderColor: c.border,
      }}
    >
      {name ? <Text style={{ fontSize: font.small, fontWeight: '700', color: nameColor ?? c.primary, marginBottom: 2 }}>{name}</Text> : null}
      <Text style={{ fontSize: font.body, color: deleted ? c.textMuted : c.text, fontStyle: deleted ? 'italic' : 'normal', lineHeight: 22 }} selectable>
        {body}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-end', marginTop: 2 }}>
        <Text style={{ fontSize: 11, color: c.textMuted }}>{time}</Text>
        {children}
      </View>
    </View>
  );
}
