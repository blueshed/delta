// Minimal login + per-user list client.
//   - connectWs + provide(WS, ...) once on load.
//   - authenticate-in-band (never in the WS URL).
//   - openDoc<Shape>(`todos:${user.id}`) for a per-user reactive signal.
//   - effect(() => ...) re-renders whenever data.get() changes.
import { effect, provide } from "@blueshed/railroad";
import {
  WS,
  call,
  connectWs,
  openDoc,
  DeltaError,
  type Doc,
} from "@blueshed/delta/client";
import type { User } from "@blueshed/delta/auth-jwt";
import "./app.css";

interface Todo {
  id: number;
  owner_id: number;
  text: string;
  done: boolean;
}
type TodosDoc = { todos: Record<string, Todo> };

const TOKEN_KEY = "{{APP}}:token";
const USER_KEY = "{{APP}}:user";

provide(WS, connectWs("/ws"));

const root = document.getElementById("app")!;

function getErrMessage(err: unknown): string {
  if (DeltaError.isDeltaError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

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

function renderLogin(prefill?: { email?: string; error?: string }) {
  root.innerHTML = "";
  const card = el("div", "card");
  card.append(el("h1", "", "Sign in"));
  const form = document.createElement("form");
  form.className = "login";
  const email = input("email", "Email", prefill?.email ?? "");
  const password = input("password", "Password", "");
  const submit = button("Sign in", "submit");
  const err = el("div", "error", prefill?.error ?? "");
  form.append(email, password, submit, err);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    submit.disabled = true;
    try {
      const user = await call<User & { token: string }>("login", {
        email: email.value.trim(),
        password: password.value,
      });
      localStorage.setItem(TOKEN_KEY, user.token);
      localStorage.setItem(
        USER_KEY,
        JSON.stringify({ id: user.id, name: user.name, email: user.email }),
      );
      renderApp(user);
    } catch (e) {
      err.textContent = getErrMessage(e);
      submit.disabled = false;
    }
  });
  card.append(form);
  card.append(
    el("p", "muted", "Seeded users: alice@example.com / bob@example.com — password: password"),
  );
  root.append(card);
}

async function renderApp(user: User & { token: string }) {
  root.innerHTML = "";
  // Await authenticate BEFORE openDoc — the open would race past auth.
  try {
    await call("authenticate", { token: user.token });
  } catch (e) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    return renderLogin({ error: getErrMessage(e) });
  }

  const doc = openDoc<TodosDoc>(`todos:${user.id}`) as Doc<TodosDoc>;

  const card = el("div", "card");
  const header = el("div", "header");
  header.append(el("h1", "", `${user.name ?? user.email ?? "{{APP}}"}`));
  const logoutBtn = button("Sign out", "button", "ghost");
  logoutBtn.addEventListener("click", async () => {
    try { await call("logout"); } catch {}
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    location.reload();
  });
  header.append(logoutBtn);
  card.append(header);

  const form = document.createElement("form");
  form.className = "row";
  const text = input("text", "Add a todo…", "");
  const add = button("Add", "submit");
  form.append(text, add);
  const err = el("div", "error", "");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const value = text.value.trim();
    if (!value) return;
    err.textContent = "";
    try {
      await doc.send([
        { op: "add", path: "/todos/-", value: { text: value, done: false, owner_id: Number(user.id) } },
      ]);
      text.value = "";
      text.focus();
    } catch (e) {
      err.textContent = getErrMessage(e);
    }
  });
  card.append(form);
  card.append(err);

  const list = document.createElement("ul");
  list.className = "todos";
  card.append(list);
  root.append(card);

  effect(() => {
    const state = doc.data.get();
    list.innerHTML = "";
    const rows = Object.values(state?.todos ?? {}).sort((a, b) => a.id - b.id);
    if (!rows.length) {
      list.append(el("li", "muted", "No todos yet."));
      return;
    }
    for (const todo of rows) {
      const li = document.createElement("li");
      if (todo.done) li.classList.add("done");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = !!todo.done;
      check.addEventListener("change", () => {
        doc
          .send([{ op: "replace", path: `/todos/${todo.id}/done`, value: check.checked }])
          .catch((e) => (err.textContent = getErrMessage(e)));
      });
      const label = el("span", "", todo.text);
      const del = button("✕", "button", "danger");
      del.addEventListener("click", () => {
        doc
          .send([{ op: "remove", path: `/todos/${todo.id}` }])
          .catch((e) => (err.textContent = getErrMessage(e)));
      });
      li.append(check, label, del);
      list.append(li);
    }
  });
}

function el(tag: string, className = "", text = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function input(type: string, placeholder: string, value: string): HTMLInputElement {
  const node = document.createElement("input");
  node.type = type;
  node.placeholder = placeholder;
  node.value = value;
  return node;
}
function button(
  text: string,
  type: "submit" | "button" = "button",
  extra = "",
): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = type;
  if (extra) node.className = extra;
  node.textContent = text;
  return node;
}

bootstrap();
