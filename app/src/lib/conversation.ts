import type { ConversationSummary } from './types';

export function conversationTitle(c: Pick<ConversationSummary, 'kind' | 'title' | 'members'>, myId: string): string {
  if (c.kind === 'group') return c.title ?? '';
  return c.members.find((m) => m.id !== myId)?.displayName ?? '—';
}

export function conversationColor(c: Pick<ConversationSummary, 'kind' | 'members'>, myId: string): string {
  if (c.kind === 'group') return '#22B5A7';
  return c.members.find((m) => m.id !== myId)?.avatarColor ?? '#999';
}
