import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { CodexPool, quotaFromUsage, weeklyResetSelector } from '../src/auth/pool.ts';
import { DshAccountStore } from '../src/auth/store.ts';
import { registerLoginFlows } from '../src/auth/login.ts';
import type { Credential, OAuthAuth } from '@earendil-works/pi-ai';
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials';

const a = 'pepabo', b = 'yukimi';
const token = (provider: string) => ({ provider, apiKey: `fixture-${provider}`, accountId: provider, headers: { 'chatgpt-account-id': provider } });
/** In-memory DSH credential store whose modifyRecord serializes like the real cross-process lock. */
function memory(initial: Record<string, CredentialRecord> = {}) {
  const records = new Map(Object.entries(initial));
  let queue = Promise.resolve();
  const provider = {
    async readRecord(key: string) { return records.get(key); },
    async modifyRecord(key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const prior = queue; let release!: () => void; queue = new Promise<void>(r => { release = r; }); await prior;
      try { const next = await mutate(records.get(key)); if (next) records.set(key, JSON.parse(JSON.stringify(next))); return records.get(key); } finally { release(); }
    },
    async deleteRecord(key: string) { records.delete(key); },
  } as unknown as CredentialProvider;
  return { provider, records };
}
const credential = (id: string, expires: number, access = 'fixture') => ({ type: 'oauth' as const, access, refresh: 'fixture-refresh', expires, accountId: id });
const grant = (value: Credential): CredentialRecord => ({ kind: 'grant', payload: value });
const stored = (m: { records: Map<string, CredentialRecord> }, key: string) => (m.records.get(key) as { payload: { access: string; accountId: string } }).payload;

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

test('undefined selection retains the previous member; no implicit arbitrary member', async () => {
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

test('DSH store reads and refreshes only its own codex-pool record', async () => {
  const m = memory({ 'codex-pool/pepabo': grant(credential('id-a', 10)), 'codex-pool/yukimi': grant(credential('id-b', 10)), 'llm-pi-ai/openai-codex': grant(credential('id-c', 10)) });
  const store = new DshAccountStore(() => m.provider, a);
  assert.equal((await store.read('openai-codex') as unknown as { accountId: string }).accountId, 'id-a');
  assert.equal(await store.read('anthropic'), undefined);
  await store.modify('openai-codex', async () => credential('id-a', 30, 'refreshed'));
  assert.equal(stored(m, 'codex-pool/pepabo').access, 'refreshed');
  assert.equal(stored(m, 'codex-pool/yukimi').accountId, 'id-b');
  assert.equal(stored(m, 'llm-pi-ai/openai-codex').accountId, 'id-c', "DSH's own provider login is untouched");
  await assert.rejects(store.modify('openai-codex', async () => ({ type: 'oauth', access: '', refresh: '', expires: 1 }) as Credential), { code: 'INVALID_REFRESH' });
  await store.delete('openai-codex');
  assert.equal(m.records.has('codex-pool/pepabo'), false);
  await assert.rejects(new DshAccountStore(() => undefined, a).modify('openai-codex', async () => credential('id-a', 1)), { code: 'NO_CREDENTIAL_STORE' });
});

test('parallel refreshes serialize and never double-refresh a rotated account', async () => {
  const m = memory({ 'codex-pool/pepabo': grant(credential('id-a', 10)) });
  const stores = [new DshAccountStore(() => m.provider, a), new DshAccountStore(() => m.provider, a)];
  let count = 0;
  await Promise.all(stores.map(store => store.modify('openai-codex', async current => {
    if (current?.type === 'oauth' && current.expires < 100) { count++; return credential('id-a', 100); } return current;
  })));
  assert.equal(count, 1);
});

test('one DSH sign-in flow per account commits the login and refuses a duplicate ChatGPT account', async () => {
  let next = credential('id-a', 100);
  const oauth = { ...builtinModels().getProvider('openai-codex')!.auth.oauth!, login: async (interaction: { notify(e: unknown): void }) => {
    interaction.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://auth.openai.com/codex/device' });
    return next;
  } } as unknown as OAuthAuth;
  const ctx = new Context();
  const m = memory();
  ctx.provide('credentials', m.provider);
  const flows = new Map<string, { label: string; run(session: unknown): Promise<void> }>();
  ctx.provide('authorization', { registerFlow: (flow: { key: string; label: string; run(session: unknown): Promise<void> }) => { flows.set(flow.key, flow); return () => { flows.delete(flow.key); }; } });
  const dispose = registerLoginFlows(ctx, [a, b], oauth);
  assert.deepEqual([...flows.keys()], ['codex-pool/pepabo', 'codex-pool/yukimi']);
  const notices: unknown[] = [];
  let target = 'codex-pool/pepabo';
  const session = { method: 'oauth', signal: new AbortController().signal, notify: (n: unknown) => notices.push(n), prompt: async () => '',
    commit: async (record: CredentialRecord) => { await m.provider.modifyRecord(target as never, async () => record); } };
  await flows.get('codex-pool/pepabo')!.run(session);
  assert.equal(stored(m, 'codex-pool/pepabo').accountId, 'id-a');
  assert.deepEqual(notices[0], { message: 'Enter this code on the verification page to finish signing in.', url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' });
  await assert.rejects(flows.get('codex-pool/yukimi')!.run(session), { code: 'DUPLICATE_ACCOUNT' });
  assert.equal(m.records.has('codex-pool/yukimi'), false);
  next = credential('id-b', 100);
  target = 'codex-pool/yukimi';
  await flows.get('codex-pool/yukimi')!.run(session);
  assert.equal(stored(m, 'codex-pool/yukimi').accountId, 'id-b');
  dispose();
  assert.equal(flows.size, 0);
});

test('/codex-login answers the method question with device code and returns the code to show', async () => {
  const { startDeviceLogin } = await import('../src/auth/login.ts');
  const ctx = new Context();
  const settle: { resolve?: (o: { status: 'authorized' }) => void } = {};
  let asked: string | undefined;
  ctx.provide('authorization', { begin: async (request: { key: string; interaction: { notify(n: unknown): void; prompt(p: unknown): Promise<string> } }) => {
    asked = await request.interaction.prompt({ kind: 'select', message: 'method', options: [{ id: 'browser', label: 'b' }, { id: 'device_code', label: 'd' }] });
    request.interaction.notify({ message: 'Enter this code', url: 'https://auth.openai.com/codex/device', code: 'WXYZ-9876' });
    return new Promise(resolve => { settle.resolve = resolve; });
  } });
  const reports: string[] = [];
  const result = await startDeviceLogin(ctx, [a, b], a, message => reports.push(message));
  assert.equal(asked, 'device_code');
  assert.equal(result.kind, 'success');
  assert.match(result.text ?? '', /^https:\/\/auth\.openai\.com\/codex\/device code WXYZ-9876 .*"pepabo"/);
  settle.resolve!({ status: 'authorized' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reports, ['Codex account "pepabo" sign-in authorized.']);
  assert.equal((await startDeviceLogin(ctx, [a, b], 'other', () => {})).kind, 'error');
});
