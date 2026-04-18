// Client-side auth bootstrap. Paste into the entry point that calls
// connectWs + openDoc. Handles session restore, login, logout, and the
// authenticate-before-open race.
import { call, openDoc, DeltaError } from "@blueshed/delta/client";
import type { User } from "@blueshed/delta/auth-jwt";

const TOKEN_KEY = "{{APP}}:token";
const USER_KEY  = "{{APP}}:user";

async function bootstrap() {
  const token = localStorage.getItem(TOKEN_KEY);
  const cached = localStorage.getItem(USER_KEY);
  if (!token || !cached) return renderLogin();
  try {
    const user = await call<User>("authenticate", { token });
    renderApp({ ...JSON.parse(cached), ...user, token });
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    renderLogin();
  }
}

async function login(email: string, password: string) {
  const user = await call<User & { token: string }>("login", { email, password });
  localStorage.setItem(TOKEN_KEY, user.token);
  localStorage.setItem(USER_KEY, JSON.stringify({ id: user.id, name: user.name, email: user.email }));
  return user;
}

async function signOut() {
  try { await call("logout"); } catch {}
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  location.reload();
}

async function afterAuth(user: User & { token: string }) {
  // AWAIT authenticate BEFORE openDoc — open would race past auth otherwise.
  await call("authenticate", { token: user.token });
  return openDoc<MyDoc>(`your-doc:${user.id}`);
}
