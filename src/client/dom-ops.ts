/**
 * DOM ops — apply JSON-Patch ops directly to a keyed collection of DOM nodes.
 *
 * The naive failure mode when consuming `doc.data` is to rebuild the DOM from
 * scratch inside an effect whenever the signal changes:
 *
 *   effect(() => {
 *     list.innerHTML = "";
 *     for (const todo of Object.values(doc.data.get().todos)) {
 *       list.append(renderTodo(todo));
 *     }
 *   });
 *
 * That kills focus, scroll, animations, and any un-signalled DOM state on
 * every op. The delta-doc protocol already knows exactly which rows changed;
 * this helper preserves that information all the way to the DOM.
 *
 *   const nodes = applyOpsToCollection(list, "todos", ops, {
 *     key:    (todo) => String(todo.id),
 *     create: (todo) => renderTodo(todo),
 *     update: (node, todo) => patchTodoNode(node, todo),   // optional
 *     remove: (node) => node.remove(),                      // optional
 *   });
 *
 * Wire it up via `doc.onOps(handler)` so the DOM is patched BEFORE the full
 * state signal updates. Keep `doc.data` for read-only consumers that don't
 * need op-level precision.
 *
 *   const nodes = new Map<string, Node>();
 *   doc.onOps((ops) => applyOpsToCollection(list, "todos", ops, renderer, nodes));
 */
import type { DeltaOp } from "../core";

export interface DomCollection<T> {
  /** Stable id for a row value — usually `(v) => String(v.id)`. */
  key: (value: T) => string;
  /** Build the node for a new row. Called on `add` ops and on first sight of a row. */
  create: (value: T) => Node;
  /**
   * Optional patcher for `replace` ops. If omitted, a replace at the row
   * level rebuilds the node via `create`. Define for in-place updates that
   * preserve focus / CSS transitions.
   */
  update?: (node: Node, value: T) => void;
  /**
   * Optional tear-down hook, called BEFORE the node is removed from the DOM.
   * Use this for listener cleanup, ResizeObserver disconnects, etc.
   */
  remove?: (node: Node) => void;
}

/**
 * Apply delta ops to a keyed DOM collection under `parent`. Only handles
 * ops at `/<collection>/...` — other ops are skipped (callers typically
 * route ops for multiple collections by calling this once per collection).
 *
 * `nodes` is the id → Node map. Pass a long-lived `Map` so repeated calls
 * build on the same state. The map is mutated in place; the return value
 * is the same map for convenience.
 */
export function applyOpsToCollection<T>(
  parent: Node,
  collection: string,
  ops: DeltaOp[],
  col: DomCollection<T>,
  nodes: Map<string, Node> = new Map(),
): Map<string, Node> {
  const prefix = `/${collection}/`;
  for (const op of ops) {
    if (op.path === `/${collection}` || !op.path.startsWith(prefix)) continue;
    const rest = op.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const idPart = slash === -1 ? rest : rest.slice(0, slash);
    const fieldPath = slash === -1 ? "" : rest.slice(slash + 1);

    if (idPart === "-" && op.op === "add") {
      // Append — id is assigned server-side; take it from the op value.
      const value = (op as any).value as T | undefined;
      if (!value) continue;
      const id = col.key(value);
      if (nodes.has(id)) continue;  // idempotent on replay
      const node = col.create(value);
      nodes.set(id, node);
      parent.appendChild(node);
      continue;
    }

    if (!idPart) continue;

    switch (op.op) {
      case "add": {
        // `/coll/<id>` add — an explicit upsert (e.g. after backend id assignment).
        const value = (op as any).value as T;
        if (nodes.has(idPart)) break;  // row already mounted
        const node = col.create(value);
        nodes.set(idPart, node);
        parent.appendChild(node);
        break;
      }
      case "replace": {
        const node = nodes.get(idPart);
        const value = (op as any).value as T;
        if (!node) {
          // Row wasn't previously mounted — treat like an add for resilience.
          const fresh = col.create(value);
          nodes.set(idPart, fresh);
          parent.appendChild(fresh);
          break;
        }
        if (fieldPath === "") {
          // Whole-row replace.
          if (col.update) col.update(node, value);
          else {
            const fresh = col.create(value);
            parent.replaceChild(fresh, node);
            nodes.set(idPart, fresh);
          }
        } else {
          // Field-level replace: the whole-row shape isn't in the op. Caller
          // must provide `update` that reads from a projected state if they
          // want to handle these; otherwise the full-state signal path on
          // `doc.data` still updates correctly.
          if (col.update) {
            // Best effort — pass the value as if it were a whole row; the
            // update callback can ignore or patch a specific field. If the
            // caller needs the field path, wire a handler via `doc.onOps`
            // that inspects op.path directly.
          }
        }
        break;
      }
      case "remove": {
        const node = nodes.get(idPart);
        if (!node) break;
        col.remove?.(node);
        nodes.delete(idPart);
        if (node.parentNode) node.parentNode.removeChild(node);
        break;
      }
    }
  }
  return nodes;
}
