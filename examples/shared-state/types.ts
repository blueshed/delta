/**
 * What someone needs in front of them to chat: one room and its messages.
 * The schema is the tables; the document is the room. The same file serves
 * the JSON file, SQLite and Postgres.
 */
import { defineDoc, defineSchema } from "../../src/server/json";

// A room is a row; its messages hang under it (the key column rooms_id).
export const schema = defineSchema({
  rooms: { columns: { name: "text?" } },
  messages: { parent: "rooms", columns: { author: "text", text: "text", at: "text" } },
});

// `implied`: the room is made by its first write.
export const room = defineDoc("room:", { root: "rooms", include: ["messages"], implied: true });

export interface Message { id: number; rooms_id: number; author: string; text: string; at: string }
export interface Room { rooms: { id: number; name: string | null }; messages: Record<string, Message> }
