# kanban

To move a card you need the board in front of you: its columns and their cards. That is one
document, `board:1`, over three tables in Postgres (`kanban_boards`, `kanban_columns`,
`kanban_cards`, in `schema.ts`). Open it and you hold it: a card someone else moves, moves on
your board too, with nothing to fetch or refresh.

## Run the page

```sh
bun run db:up
bun examples/kanban/serve.ts                   # port 3100
PORT=3199 bun examples/kanban/serve.ts         # if 3100 is busy
```

Open <http://localhost:3100> in two tabs. Click a card and it moves to the next column in both.
Double-click a column title to rename it; "+ add card" adds one. Each is one op: `replace` for a
move or a rename, `add` for a card. Each run resets the board.

`client.tsx` is the whole page:

```tsx
provide(WS, connectWs("/ws"));                     // openDoc finds the socket
const doc = openDoc<BoardDoc>("board:1");           // doc.data is a signal of the board

// a column's cards, keyed by id: a moved card re-renders, the rest stay
{list<Card>(cards$, (c) => c.id, (c$) => <CardItem card$={c$} />)}

// a move is one op on one path
await doc.send([{ op: "replace", path: `/kanban_cards/${id}/kanban_columns_id`, value: nextId }]);
```

## Run it in the terminal

```sh
bun run db:up
bun run examples/kanban/run.ts
```

Alice and Bob open the board over two sockets. Alice renames a column, moves a card and adds
one in a single `send`; the script prints what Bob was told and his board after it. Then Charlie
opens the board late and gets the same.

`tests/postgres-examples.test.ts` runs both: two browsers on `serve.ts` (one clicks a card, both
see it move), and `run.ts`.

## Left out

- Who may see a board: one person, no auth. See [../todos-vs-rls/](../todos-vs-rls/).
- Drag and drop: a drop is the same `replace` as a click.
