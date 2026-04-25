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

interface Message { author: string; text: string; at: string }
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

// 1. Initial paint — once the open response arrives, render every message.
await doc.ready;
for (const [id, m] of Object.entries(doc.data.get()?.messages ?? {})) {
  const node = renderMessage(m);
  node.dataset.id = id;
  log.append(node);
}
log.scrollTop = log.scrollHeight;

// 2. Live ops — patch keyed DOM nodes without rebuilding the list.
doc.onOps((ops) =>
  applyOpsToCollection(log, "messages", ops, {
    create: renderMessage,
    update: (node, m) => {
      (node.firstElementChild as HTMLElement).textContent = m.author;
      (node.lastElementChild  as HTMLElement).textContent = m.text;
    },
  }),
);

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const id = crypto.randomUUID();
  await doc.send([{
    op: "add", path: `/messages/${id}`,
    value: { author: authorI.value, text: textI.value, at: new Date().toISOString() },
  }]);
  textI.value = "";
  textI.focus();
});

authorI.value = localStorage.getItem("chat:author") ?? "";
authorI.addEventListener("change", () => localStorage.setItem("chat:author", authorI.value));
