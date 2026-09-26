// Operator-only: make an existing Auth user the installation owner.
// Works once while no owner exists; there is no client or API route for this.
//
//   DATABASE_URL=postgresql://... pnpm ops:bootstrap-owner --user-id <auth-user-uuid>
//
// DATABASE_URL must be the project's direct database connection string, held only
// by the operator. The action is recorded in private.audit_events.
import { parseArgs } from 'node:util';
import postgres from 'postgres';

const { values } = parseArgs({ options: { 'user-id': { type: 'string' } } });
const userId = values['user-id'];
if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) {
  console.error('Usage: pnpm ops:bootstrap-owner --user-id <auth-user-uuid>');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  const [row] = await sql`select private.bootstrap_owner(${userId}::uuid) as result`;
  console.log(`Owner bootstrapped: ${JSON.stringify(row.result)}`);
} catch (error) {
  console.error(`Bootstrap refused: ${error.message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
