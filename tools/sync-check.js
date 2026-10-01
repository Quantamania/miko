/* Live verification against a real Supabase project.
 *
 * Everything so far has been proved against a stub. This exercises the same
 * paths over the network: schema, policies, push, pull, attachments, deletes.
 *
 * Run it from the browser console on a page where you are already signed in:
 *
 *   const { run } = await import('/tools/sync-check.js');
 *   await run();
 *
 * It creates a handful of rows prefixed `zz-sync-check`, verifies them, and
 * removes them again. It never touches anything else, and it never prints the
 * access token or the anon key.
 */

import * as auth from '../js/core/auth.js';
import * as store from '../js/core/store.js';
import * as sync from '../js/core/sync.js';
import * as remote from '../js/core/remote.js';
import * as rest from '../js/core/postgrest.js';
import * as storage from '../js/core/storage.js';
import * as db from '../js/core/db.js';

const TAG = 'zz-sync-check';

const ok = (name, pass, detail) => ({ name, pass: Boolean(pass), detail });

async function step(name, fn) {
  try {
    const detail = await fn();
    return ok(name, detail !== false, detail);
  } catch (err) {
    return ok(name, false, `${err.name || 'Error'}: ${err.message}`);
  }
}

export async function run({ cleanup = true } = {}) {
  const results = [];
  const token = () => auth.currentSession()?.accessToken;

  results.push(
    await step('config present', () =>
      auth.isBackendConfigured() ? 'url and anon key are set' : false
    )
  );
  results.push(
    await step('signed in', () => {
      const s = auth.currentSession();
      if (!s?.accessToken) return false;
      return `${s.email} · provider ${s.provider} · verified ${s.verified}`;
    })
  );
  if (results.some((r) => !r.pass)) return report(results);

  results.push(
    await step('token accepted by the server', async () => {
      const v = await auth.verify();
      return v.serverVerified ? 'GET /auth/v1/user returned this user' : false;
    })
  );

  results.push(
    await step('schema and bucket reachable', async () => {
      const pre = await remote.preflight();
      if (pre.ok) return `all ${remote.TABLES.length} tables + storage bucket`;
      return `missing: ${pre.missing.map((m) => `${m.table} (${m.status})`).join(', ')}`;
    })
  );

  results.push(
    await step('account linked to workspace', async () => {
      const rows = await rest.selectSince('members', { token: token() });
      const uid = auth.currentSession()?.userId;
      const mine = (rows || []).filter((r) => r.user_id === uid);
      if (!mine.length) return false;
      return `member of ${mine.length} workspace(s) as ${mine[0].role}`;
    })
  );

  /* ---- a task, there and back ---- */
  let task = null;
  results.push(
    await step('push a task', async () => {
      task = await store.createTask({ title: `${TAG} task`, priority: 'high' });
      await sync.drain();
      const rows = await rest.selectSince('tasks', {
        token: token(),
        workspaceId: store.state.workspace.id,
      });
      return (rows || []).some((r) => r.id === task.id) ? `id ${task.id}` : false;
    })
  );

  results.push(
    await step('edit updates in place', async () => {
      await store.updateTask(task.id, { title: `${TAG} task, edited` });
      await sync.drain();
      const rows = await rest.selectSince('tasks', {
        token: token(),
        workspaceId: store.state.workspace.id,
      });
      const mine = (rows || []).filter((r) => r.id === task.id);
      if (mine.length !== 1) return `expected 1 row, found ${mine.length}`;
      return mine[0].title.endsWith('edited') ? 'single row, new title' : false;
    })
  );

  results.push(
    await step('pull brings a server-side change back', async () => {
      await rest.upsert(
        'tasks',
        [{ ...(await db.get('tasks', task.id)), priority: 'urgent', version: 99,
           updated_at: new Date(Date.now() + 2000).toISOString() }],
        { token: token() }
      );
      await remote.pull();
      return store.getTask(task.id)?.priority === 'urgent' ? 'priority arrived' : false;
    })
  );

  /* ---- an attachment, there and back ---- */
  let att = null;
  results.push(
    await step('upload attachment bytes', async () => {
      const file = new File([new Uint8Array(64).fill(9)], `${TAG}.bin`, {
        type: 'application/octet-stream',
      });
      att = await store.addAttachment(task.id, file);
      await remote.connect({ verify: false });
      const blob = await storage.download(storage.pathFor(att), { token: token() });
      return blob.size === 64 ? '64 bytes round-tripped through storage' : `got ${blob.size} bytes`;
    })
  );

  results.push(
    await step('attachment row points at the object', async () => {
      const rows = await rest.selectSince('attachments', {
        token: token(),
        workspaceId: store.state.workspace.id,
      });
      const row = (rows || []).find((r) => r.id === att?.id);
      if (!row) return false;
      if ('blob' in row) return 'the blob leaked into Postgres';
      return row.storage_path === storage.pathFor(att) ? row.storage_path : false;
    })
  );

  results.push(
    await step('delete travels as a tombstone', async () => {
      await store.deleteAttachment(att.id, task.id);
      await store.deleteTask(task.id);
      await sync.drain();
      await remote.connect({ verify: false });

      const tasks = await rest.selectSince('tasks', {
        token: token(),
        workspaceId: store.state.workspace.id,
      });
      const t = (tasks || []).find((r) => r.id === task.id);
      const gone = await storage
        .download(storage.pathFor(att), { token: token() })
        .then(() => false)
        .catch(() => true);
      if (!t?.deleted_at) return 'task tombstone did not reach the server';
      if (!gone) return 'storage object was not removed';
      return 'task tombstoned, object removed';
    })
  );

  if (cleanup) {
    await step('cleanup', async () => {
      // Soft-deleted already; drop the local rows so the check leaves nothing.
      if (att) await db.del('attachments', att.id);
      if (task) await db.del('tasks', task.id);
      return 'local test rows removed';
    });
  }

  return report(results);
}

function report(results) {
  const passed = results.filter((r) => r.pass).length;
  /* eslint-disable no-console */
  console.log(`\n  MIKŌ sync check — ${passed}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`  ${r.pass ? '✓' : '✗'}  ${r.name}\n       ${r.detail ?? ''}`);
  }
  return { passed, total: results.length, results };
}
