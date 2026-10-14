export type Me = {
  user: { id: string; kind: 'adult' | 'child'; displayName: string | null; avatarColor: string; phone: string | null };
  families: Array<{
    id: string;
    name: string;
    role: 'owner' | 'admin';
    isDemo: boolean;
    canManageContacts: boolean;
    canApproveRequests: boolean;
    canChangeSettings: boolean;
  }>;
  child: { familyId: string; familyName: string; allowContactRequests: boolean; allowProfileEdit: boolean; readReceipts: boolean } | null;
  unreadNotifications: number;
  deviceId: string;
};

export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  clientId: string;
  kind: 'text';
  body: string | null;
  createdAt: string;
  deletedAt: string | null;
};

export type Member = {
  id: string;
  displayName: string | null;
  avatarColor: string;
  kind: 'adult' | 'child';
  leftAt: string | null;
  lastDeliveredAt: string | null;
  lastReadAt: string | null;
};

export type ConversationSummary = {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  familyId: string;
  lastMessageAt: string | null;
  unread: number;
  lastMessage: Message | null;
  canSend: boolean;
  members: Member[];
};

export type Person = {
  id: string;
  displayName: string | null;
  avatarColor: string;
  relation: 'parent' | 'sibling' | 'contact' | 'child' | 'coparent' | 'contact_child';
  familyName?: string;
};

export type ApprovalStatus = 'pending_verification' | 'pending_parent_approval' | 'approved' | 'rejected' | 'blocked' | 'removed';

export type Permissions = { canMessage: boolean; canSendMedia: boolean; canVoice: boolean; canCall: boolean };
