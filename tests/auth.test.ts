import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexPool, quotaFromUsage, weeklyResetSelector } from '../src/auth/pool.ts';
import { PiAccountStore, type LockedBackend } from '../src/auth/pi-store.ts';
import type { Credential } from '@earendil-works/pi-ai';

const a = 'openai-codex-2', b = 'openai-codex-3';
const token = (provider: string) => ({ provider, apiKey: `fixture-${provider}`, accountId: provider, headers: { 'chatgpt-account-id': provider } });
function memory(initial: Record<string, Credential>) {
  let current = JSON.stringify(initial), queue = Promise.resolve();
  const backend: LockedBackend = { async withLockAsync(fn) {
    const prior = queue; let release!: () => void; queue = new Promise<void>(r => { release = r; }); await prior;
    try { const result = await fn(current); if (result.next) current = result.next; return result.result; } finally { release(); }
  } };
  return { backend, state: () => JSON.parse(current) };
}
const credential = (id: string, expires: number, access = 'fixture') => ({ type: 'oauth' as const, access, refresh: 'fixture-refresh', expires, accountId: id });

test('weekly selector uses minimum across windows, filters below 20%, prefers nearest future weekly reset', async () => {
  assert.equal(quotaFromUsage(a, { rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000 }, secondary_window: { used_percent: 70, limit_window_seconds: 604800, reset_at: 20 } } }).remainingPercent, 30);
  assert.equal(quotaFromUsage(a, { rate_limit: { allowed: false } }).remainingPercent, 0);
  assert.equal(quotaFromUsage(a, { rate_limit: { primary_window: { used_percent: 101, limit_window_seconds: 1 } } }).remainingPercent, undefined);
  const quotas = [{ provider: a, kind: 'ready' as const, remainingPercent: 20, weeklyResetAt: 20 }, { provider: b, kind: 'ready' as const, remainingPercent: 90, weeklyResetAt: 30 }];
  assert.equal(await weeklyResetSelector({ members: [a, b], timestamp: 1000, reason: 'auth-use', modelId: '', getQuota: async p => quotas.find(q => q.provider === p) }), a);
  quotas[0].remainingPercent = 19;
  assert.equal(await weeklyResetSelector({ members: [a, b], timestamp: 1000, reason: 'auth-use', modelId: '', getQuota: async p => quotas.find(q => q.provider === p) }), b);
});

test('all operations select before auth, share 30s quota cache, and preserve frozen leases', async () => {
  let now = 0, count = 0;
  const pool = new CodexPool({ members: [a, b], selector: weeklyResetSelector, resolveAuth: async p => token(p), now: () => now,
    getQuota: async provider => { count++; return { provider, kind: 'ready', remainingPercent: 50, weeklyResetAt: provider === a ? 50 : 60 }; } });
  const leases = await Promise.all((['chat', 'web', 'image', 'compact'] as const).map(op => pool.acquire(op)));
  assert.deepEqual(leases.map(x => x.provider), [a, a, a, a]); assert.equal(count, 2);
  pool.markLimited(a, 60_000); assert.equal((await pool.acquire('chat')).provider, b); assert.equal(leases[0].provider, a);
  now = 30_001; await pool.acquire('web'); assert.equal(count, 3);
});

test('undefined selection retains previous member like Pi; no implicit arbitrary member', async () => {
  const common = { members: [a, b], selector: async () => undefined, resolveAuth: async (p: string) => token(p), getQuota: async (provider: string) => ({ provider, kind: 'blocked' as const }) };
  assert.equal((await new CodexPool({ ...common, initialAccount: a }).acquire('chat')).provider, a);
  await assert.rejects(new CodexPool(common).acquire('chat'), { code: 'POOL_UNAVAILABLE' });
  await assert.rejects(new CodexPool({ ...common, selector: async () => 'unexpected' }).acquire('chat'), { code: 'INVALID_SELECTION' });
});

test('cancelled authentication is not replaced by stale auth', async () => {
  const c = new AbortController(); c.abort();
  const pool = new CodexPool({ members: [a], selector: weeklyResetSelector, resolveAuth: async p => token(p), getQuota: async provider => ({ provider, kind: 'ready', remainingPercent: 100 }) });
  await assert.rejects(pool.acquire('chat', '', c.signal), { name: 'AbortError' });
});

test('shared store reads freshest same-account alias and atomically refreshes mirrors only', async () => {
  const m = memory({ [a]: credential('id-a', 10), [b]: credential('id-b', 10), 'openai-codex': credential('id-a', 20, 'new'), anthropic: { type: 'api_key', key: 'fixture-other' } });
  const store = new PiAccountStore(m.backend, a, [a, b]);
  assert.equal((await store.read('openai-codex'))?.type, 'oauth');
  assert.equal((await store.read('openai-codex') as { access: string }).access, 'new');
  await store.modify('openai-codex', async () => credential('id-a', 30, 'refreshed'));
  assert.equal(m.state()[a].access, 'refreshed'); assert.equal(m.state()['openai-codex'].access, 'refreshed'); assert.equal(m.state()[b].accountId, 'id-b'); assert.equal(m.state().anthropic.key, 'fixture-other');
  await assert.rejects(store.modify('openai-codex', async () => credential('id-b', 100)), { code: 'ACCOUNT_CHANGED' });
  await assert.rejects(store.delete(), { code: 'MANAGE_IN_PI' });
});

test('parallel refreshes serialize and never double-refresh a rotated account', async () => {
  const m = memory({ [a]: credential('id-a', 10), 'openai-codex': credential('id-b', 10), [b]: credential('id-b', 10) });
  const stores = [new PiAccountStore(m.backend, a, [a, b]), new PiAccountStore(m.backend, a, [a, b])];
  let count = 0;
  await Promise.all(stores.map(store => store.modify('openai-codex', async current => {
    if (current?.type === 'oauth' && current.expires < 100) { count++; return credential('id-a', 100); } return current;
  })));
  assert.equal(count, 1); assert.equal(m.state()['openai-codex'].accountId, 'id-b');
});
