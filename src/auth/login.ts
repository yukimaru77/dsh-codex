import type { Context } from '@deepseek-ai/cordis';
import { AuthorizationDeclinedError, type AuthorizationNotice, type AuthorizationPrompt, type AuthorizationSession } from '@deepseek-ai/dsh-authorization';
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import { setTimeout as delay } from 'node:timers/promises';
import type { AuthEvent, AuthPrompt, Credential, OAuthAuth } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { PoolError } from './pool.ts';
import { accountId, DshAccountStore, recordKeyFor } from './store.ts';

// relay()/restate() follow @deepseek-ai/dsh-llm-pi-ai's own pi-ai login bridge
// (MIT), so these flows render exactly like DSH's built-in provider sign-ins.
function relay(event: AuthEvent, session: AuthorizationSession): void {
  switch (event.type) {
    case 'info': {
      const link = event.links?.[0];
      session.notify({ message: event.message, ...(link ? { url: link.url } : {}) });
      return;
    }
    case 'auth_url': session.notify({ message: event.instructions ?? 'Open this page to continue signing in.', url: event.url }); return;
    case 'device_code': session.notify({ message: 'Enter this code on the verification page to finish signing in.', url: event.verificationUri, code: event.userCode }); return;
    case 'progress': session.notify({ message: event.message }); return;
    default: session.notify({ message: 'Signing in…' });
  }
}
function restate(prompt: AuthPrompt): AuthorizationPrompt {
  const signal = prompt.signal ? { signal: prompt.signal } : {};
  switch (prompt.type) {
    case 'select': return { ...signal, kind: 'select', message: prompt.message, options: prompt.options };
    case 'secret': return { ...signal, kind: 'secret', message: prompt.message, ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }) };
    default: return { ...signal, kind: 'text', message: prompt.message, ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }) };
  }
}

/**
 * One DSH authorization flow per pool account, so Web settings and the TUI sign in
 * to `codex-pool/<account>` the same way they sign in to any built-in provider.
 * Two accounts holding the same ChatGPT login would share one rotating refresh
 * token, so a login already held by another account is refused.
 */
export function registerLoginFlows(ctx: Context, accounts: readonly string[], oauth: OAuthAuth | undefined = builtinModels().getProvider('openai-codex')?.auth.oauth): () => void {
  if (!oauth) throw new PoolError('NO_CODEX_LOGIN', 'The installed pi-ai catalog ships no OpenAI Codex login.');
  const stores = new Map(accounts.map(account => [account, new DshAccountStore(() => ctx.get('credentials'), account)]));
  const disposers = accounts.map(account => ctx.authorization.registerFlow({
    key: recordKeyFor(account),
    label: `ChatGPT Codex (${account})`,
    methods: [{ id: 'oauth', label: oauth.loginLabel ?? 'Sign in with ChatGPT' }],
    async run(session) {
      const credential: Credential = await oauth.login({
        signal: session.signal,
        notify: event => relay(event, session),
        prompt: prompt => session.prompt(restate(prompt)),
      });
      const id = accountId(credential);
      if (!id) throw new PoolError('INVALID_LOGIN', 'The Codex login returned no ChatGPT account.');
      for (const [other, store] of stores) {
        if (other !== account && accountId(await store.read('openai-codex')) === id) {
          throw new PoolError('DUPLICATE_ACCOUNT', `This ChatGPT account is already signed in as "${other}"; sign in a different account here.`);
        }
      }
      await session.commit({ kind: 'grant', payload: credential });
    },
  }));
  return () => { for (const dispose of disposers) dispose(); };
}

/**
 * `/codex-login <account>`: DSH 0.2.1-rc.2 has no surface that starts plugin
 * authorization flows, so a command starts one with a device code. It returns as
 * soon as the code is shown; the attempt keeps polling and commits in the background.
 */
export async function startDeviceLogin(ctx: Context, accounts: readonly string[], account: string, report: (message: string) => void, waitMs = 30_000): Promise<CommandResult> {
  if (!accounts.includes(account)) return { kind: 'error', text: `Usage: /codex-login <${accounts.join('|')}>` };
  let shown!: (notice: AuthorizationNotice) => void;
  const notice = new Promise<AuthorizationNotice>(resolve => { shown = resolve; });
  const attempt = ctx.authorization.begin({
    key: recordKeyFor(account),
    interaction: {
      notify: next => { if (next.code && next.url) shown(next); },
      async prompt(prompt) {
        if (prompt.kind === 'select' && prompt.options.some(option => option.id === 'device_code')) return 'device_code';
        throw new AuthorizationDeclinedError('Only device-code sign-in can be answered from a command.');
      },
    },
  });
  attempt.then(
    outcome => report(`Codex account "${account}" sign-in ${outcome.status}.`),
    (error: unknown) => report(`Codex account "${account}" sign-in failed: ${error instanceof Error ? error.message : String(error)}`),
  );
  const first = await Promise.race([
    notice.then(value => ({ notice: value })),
    attempt.then(outcome => ({ outcome }), (error: unknown) => ({ error })),
    delay(waitMs, { timeout: true as const }),
  ]);
  if ('notice' in first) {
    // Surfaces may show this on one truncated line, so the URL and code come first.
    return { kind: 'success', text: `${first.notice.url} code ${first.notice.code} — sign in as the ChatGPT account for "${account}"; it finishes in the background (/codex-pool shows signed-in accounts).` };
  }
  if ('error' in first) return { kind: 'error', text: `Sign-in for "${account}" failed: ${first.error instanceof Error ? first.error.message : String(first.error)}` };
  if ('outcome' in first) return { kind: 'error', text: `Sign-in for "${account}" ended (${first.outcome.status}) before a code was shown.` };
  return { kind: 'error', text: `No device code was shown for "${account}" within ${waitMs / 1000}s; try again.` };
}
