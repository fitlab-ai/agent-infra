export type CommandRole = 'read' | 'write' | 'exec';

type AuthConfig = {
  users?: unknown;
};

const ROLE_RANK: Record<CommandRole, number> = { read: 1, write: 2, exec: 3 };

function userRole(auth: AuthConfig, key: string): CommandRole | null {
  const users = auth.users;
  if (!users || typeof users !== 'object' || Array.isArray(users)) return null;
  const record = (users as Record<string, unknown>)[key];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const role = (record as Record<string, unknown>).role;
  return role === 'read' || role === 'write' || role === 'exec' ? role : null;
}

export function authorize(
  user: { adapter: string; userId: string },
  required: CommandRole,
  auth: AuthConfig | undefined
): { ok: true } | { ok: false; message: string } {
  const role = userRole(auth ?? {}, `${user.adapter}:${user.userId}`);
  if (!role || ROLE_RANK[role] < ROLE_RANK[required]) {
    return { ok: false, message: `requires ${required}` };
  }
  return { ok: true };
}
