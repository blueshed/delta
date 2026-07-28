/**
 * Three concepts: connect, open, send.
 *
 *   const ws  = connectWs("/ws");      // reconnecting WebSocket client
 *   const doc = openDoc("chat:room");   // reactive doc — auto-updates on every op
 *   doc.send([{ op: "add", path: "/messages/<id>", value: {...} }]);
 *
 * No fetch, no polling. The shape lives in `doc.data.get()`; ops mutate it
 * in place; every subscriber receives the same op stream via `onOps`.
 */
import { connectWs, openDoc, type Doc } from "../../src/client/client";
import { applyOpsToCollection } from "../../src/client/dom-ops";

// `id` carries the same uuid the op path uses (`/messages/<id>`) — the DOM
// renderer keys rows by it, so the per-op and whole-doc paths agree.
interface Message { id: string; author: string; text: string; at: string }
interface ChatDoc { messages: Record<string, Message> }

const ws = connectWs("/ws");
const doc: Doc<ChatDoc> = openDoc<ChatDoc>("chat:room", ws);

const log     = document.getElementById("log") as HTMLDivElement;
const form    = document.getElementById("composer") as HTMLFormElement;
const authorI = document.getElementById("author") as HTMLInputElement;
const textI   = document.getElementById("text")   as HTMLInputElement;

function renderMessage(m: Message): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "msg";
  row.innerHTML = `<span class="author"></span><span class="text"></span>`;
  (row.firstElementChild as HTMLElement).textContent = m.author;
  (row.lastElementChild  as HTMLElement).textContent = m.text;
  return row;
}

// One render path for everything: the first paint, every live op, and the
// synthetic whole-doc replace that `onOps` emits on reconnect. `nodes` (the
// id → node map) is kept per (log, "messages") inside applyOpsToCollection,
// so it persists across calls — that persistence is what lets `remove` find
// its node and stops a reconnect re-appending the whole list.
const render = (ops: Parameters<Parameters<typeof doc.onOps>[0]>[0]) =>
  applyOpsToCollection<Message>(log, "messages", ops, {
    key: (m) => m.id,
    create: renderMessage,
    update: (node, m) => {
      const el = node as HTMLElement;
      (el.firstElementChild as HTMLElement).textContent = m.author;
      (el.lastElementChild  as HTMLElement).textContent = m.text;
    },
  });

await doc.ready;
render([{ op: "replace", path: "", value: doc.data.get() }]);   // initial paint
log.scrollTop = log.scrollHeight;
doc.onOps(render);                                             // live + reconnect

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const id = crypto.randomUUID();
  await doc.send([{
    op: "add", path: `/messages/${id}`,
    value: { id, author: authorI.value, text: textI.value, at: new Date().toISOString() },
  }]);
  textI.value = "";
  textI.focus();
});

authorI.value = localStorage.getItem("chat:author") ?? "";
authorI.addEventListener("change", () => localStorage.setItem("chat:author", authorI.value));
