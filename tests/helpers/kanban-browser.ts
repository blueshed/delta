/**
 * One browser on examples/kanban (tests/postgres-examples.test.ts): the page
 * in happy-dom, its client.tsx over Bun's own WebSocket to the server on PORT
 * (run from examples/kanban, so Bun takes railroad's JSX from its tsconfig).
 * It says "ready" once the board shows; with CLICK, clicks that card; then it
 * exits once card SEE is in column IN, or fails after 5 s.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const Native = globalThis.WebSocket;
GlobalRegistrator.register({ url: `http://localhost:${process.env.PORT}/` });
globalThis.WebSocket = Native;

const page = new URL("../../examples/kanban/", import.meta.url);
const html = await Bun.file(new URL("index.html", page)).text();
document.body.innerHTML = html.replace(/<!doctype html>/i, "").replace(/<script[^>]*><\/script>/, "");
await import(new URL("client.tsx", page).pathname);   // not a literal, so bun check leaves its JSX to the example's tsconfig

/** Column title -> the titles of its cards. */
const board = () => Object.fromEntries([...document.querySelectorAll(".column")].map((c) =>
  [c.querySelector("h3")!.textContent, [...c.querySelectorAll(".card")].map((x) => x.textContent)]));
const cards = () => [...document.querySelectorAll<HTMLElement>(".card")];
const wait = async (done: () => boolean) => { for (let i = 0; i < 500 && !done(); i++) await Bun.sleep(10); };

await wait(() => cards().length > 0);
console.log("ready");
if (process.env.CLICK) cards().find((c) => c.textContent === process.env.CLICK)!.click();
const seen = () => board()[process.env.IN!]?.includes(process.env.SEE!) ?? false;
await wait(seen);
console.log(`board ${JSON.stringify(board())}`);
process.exit(seen() ? 0 : 1);
