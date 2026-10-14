import type { Ctx } from './context.js';

/** Applies each family's message retention policy and removes expired one-time codes. */
export async function runMaintenance(ctx: Ctx): Promise<{ messagesDeleted: number }> {
  const res = await ctx.db.query(
    `DELETE FROM messages m USING conversations c, retention_policies rp
      WHERE m.conversation_id = c.id AND rp.family_id = c.family_id
        AND rp.message_retention_days IS NOT NULL
        AND m.created_at < now() - make_interval(days => rp.message_retention_days)`,
  );
  await ctx.db.query(`DELETE FROM otp_challenges WHERE created_at < now() - interval '2 days'`);
  await ctx.db.query(`DELETE FROM pairing_codes WHERE expires_at < now() - interval '2 days'`);
  return { messagesDeleted: res.rowCount ?? 0 };
}
