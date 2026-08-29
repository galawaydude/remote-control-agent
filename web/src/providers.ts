/**
 * Provider ids and folder-trust wording used by the session list and New session sheet.
 *
 * The ids are the server's own (`DEFAULT_PROVIDER` in `machine/registry.ts`,
 * `CODEX` in `providers/codex/spawn.ts`) and the create route validates against
 * the same set, so a typo here is a 400 rather than a session started under the
 * wrong agent. They are literals because `@tether/shared` emits types and no
 * JavaScript — there is nothing to import a value from.
 *
 * Like every other display decision in the web app this lives in a `.ts` rather
 * than a `.tsx`: the tests run under `node --test`, which strips types but does
 * not compile JSX.
 */

import type { FolderTrust } from '@tether/shared';

/** The provider a session gets when nothing says otherwise. */
export const DEFAULT_PROVIDER = 'claude-code';

export const CODEX = 'codex';

export const PROVIDERS = [
  { id: DEFAULT_PROVIDER, label: 'Claude Code' },
  { id: CODEX, label: 'Codex' },
] as const;

/**
 * A provider's name, or the raw id for one this build has not heard of. Falling
 * back to the id shows what is known without guessing or blanking the row.
 */
export function providerLabel(provider: string): string {
  return PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
}

/**
 * What the New session sheet says about folder trust, before the agent starts.
 *
 * Here rather than in the `.tsx` for the usual reason — the tests cannot compile
 * JSX — and here rather than anywhere else because every sentence names the
 * agent, and this module is where the web app reads an agent's name.
 *
 * The shape of the answer decides the shape of the ask:
 *
 * - **trusted** — nothing at all. There is no question to put in front of anyone,
 *   and a reassuring line about a folder the agent was always going to accept is
 *   the nagging the consent pattern rules out.
 * - **untrusted** — the explanation and a box to tick. Unticked is a real answer
 *   and the default: the session still starts and the agent asks in the terminal,
 *   exactly as it does today, which the last line says so the consequence of
 *   declining is visible rather than discovered.
 * - **unknown** — the explanation with no box. tether says it cannot tell instead
 *   of guessing, and offers nothing, because the file it would have to write is
 *   the one it has just failed to understand.
 *
 * `path` is the directory the answer is *about* and is named whenever it differs
 * from the one being started in: Codex keys trust by repository, so a session in
 * `repo/sub` trusts `repo` and everything else under it. A control that said
 * "this folder" over that would be a lie by omission on a security decision.
 */
export type TrustAsk = {
  /** Paragraphs, in order. */
  lines: readonly string[];
  /** The checkbox's label — absent when there is nothing to offer. */
  accept?: string;
};

export function trustAsk(
  provider: string,
  trust: FolderTrust,
  path: string,
  cwd: string,
): TrustAsk | null {
  const agent = providerLabel(provider);
  if (trust === 'trusted') return null;
  if (trust === 'unknown') {
    return {
      lines: [
        `Remote Control Agent cannot tell whether ${agent} already trusts ${path} — its configuration ` +
          `could not be read, so it will not guess or write to it.`,
        `The session starts either way. If ${agent} does not trust this folder yet, it will ask in ` +
          `the terminal, and you can answer it there.`,
      ],
    };
  }
  const scope =
    path === cwd
      ? `${agent} has not been told to trust ${path}.`
      : `${agent} has not been told to trust ${path}, the repository ${cwd} is in — it records ` +
        `trust per repository, so this covers every directory inside it.`;
  return {
    lines: [
      `${scope} Trusting it lets ${agent} read, change and run files there, including anything a ` +
        `file in it tells ${agent} to do.`,
      `Your answer is remembered in ${agent}'s own settings, so it will not ask again. Leave this ` +
        `unticked and the session still starts — ${agent} will ask you in the terminal instead.`,
    ],
    accept: `I trust this folder`,
  };
}

/**
 * Why a dead session cannot be brought back, when it cannot.
 *
 * Codex creates no session identity until the first input, so a session closed
 * before anyone typed has nothing exact to resume. The server refuses rather
 * than starting a fresh process under a resumed row.
 */
export function unresumableNote(session: {
  deadAt: number | null;
  providerSessionId: string | null;
}): string | null {
  if (session.deadAt === null || session.providerSessionId !== null) return null;
  return 'no saved session to resume — it never received input';
}
