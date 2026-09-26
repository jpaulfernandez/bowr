import { randomUUID } from 'node:crypto';
import { admin, sql } from './stack';

export type Identity = { id: string; email: string };
type State = 'pending' | 'active' | 'suspended' | 'deleting';

/** AUTH fixture: an Auth user whose membership is set directly by the test harness. */
export async function createIdentity(
  label: string,
  { state = 'active', role = 'member', displayName }: { state?: State; role?: 'owner' | 'member'; displayName?: string } = {},
): Promise<Identity> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const { data, error } = await admin().auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('createUser failed');
  const id = data.user.id;
  const db = sql();
  if (role === 'owner') await db`update private.memberships set role = 'member' where role = 'owner'`;
  await db`
    update private.memberships set
      state = ${state},
      role = ${role},
      joined_at = case when ${state} in ('active', 'suspended') then now() end,
      suspended_at = case when ${state} = 'suspended' then now() end,
      deleting_at = case when ${state} = 'deleting' then now() end,
      deletion_reason = case when ${state} = 'deleting' then 'account_deleted' end
    where user_id = ${id}`;
  if (displayName) await db`update public.profiles set display_name = ${displayName} where id = ${id}`;
  return { id, email };
}
