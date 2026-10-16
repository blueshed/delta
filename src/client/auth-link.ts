/**
 * Link sign-in in the page (`@blueshed/delta/auth-link` is the server's): take a link, sign out,
 * and in development, be anyone. The session is an HttpOnly cookie the page never reads: the socket
 * carries it when it connects, so take a link before the socket connects.
 *
 *   const taken = await takeLink();          // the page opened at <site>/#/in/<token>: signed in
 *   provide(WS, connectWs("/ws"));           // ...and this socket is them
 *   const me = await call<Person | null>("me");
 */

/** Someone, as the server's `personOf` answers them. */
export type Person = { id: number; [field: string]: unknown };

const failed = async (res: Response) => ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? "Not signed in";

/**
 * If the page was opened by a link (`#/in/<token>`), use it: signed in as its person, and the page's
 * address goes where the link opens (else its start), with the token gone from it. A link used or
 * run out answers why. Null when the page was not opened by a link.
 */
export async function takeLink(): Promise<{ person: Person } | { error: string } | null> {
  const token = /^#\/in\/([A-Za-z0-9_-]+)$/.exec(location.hash)?.[1];
  if (!token) return null;
  const res = await fetch(`/api/in/${token}`, { method: "POST" });
  if (!res.ok) {
    history.replaceState(null, "", location.pathname + location.search);
    return { error: await failed(res) };
  }
  const { opens, ...person } = (await res.json()) as Person & { opens: string | null };
  history.replaceState(null, "", location.pathname + location.search + (opens ? `#${opens}` : ""));
  return { person };
}

/** Sign out, and start the page again as nobody. */
export async function signOut(): Promise<void> {
  await fetch("/api/out", { method: "POST" });
  location.reload();
}

/** Development only: everyone, for "Who are you?". Empty in production. */
export async function everyone<P extends Person = Person>(): Promise<P[]> {
  const res = await fetch("/api/dev/people");
  return res.ok ? ((await res.json()) as P[]) : [];
}

/** Development only: be `id`, and start the page again as them. */
export async function becomeAs(id: number): Promise<void> {
  const res = await fetch(`/api/dev/as/${id}`, { method: "POST" });
  if (!res.ok) throw new Error(await failed(res));
  location.reload();
}
