/**
 * The path's custom documents as Postgres reads them (its pool): the first
 * reads `src/cases/path.ts` leaves to each backend. SQLite's are in the
 * package beside the cases; these go to dzql with the rest of Postgres.
 */
import { emailsDoc, guestsDoc, inboxDoc, menuCardDoc, openSeatsDoc, pathSchema } from "@blueshed/delta/testing";

const householdsTable = pathSchema.tables.households!.name;
const seatsTable = pathSchema.tables.seats!.name;
const weddingsTable = pathSchema.tables.weddings!.name;
const coursesTable = pathSchema.tables.courses!.name;

// each row as JSON, as a document reads it: pg gives a bare BIGINT column as text
export const postgresInbox = inboxDoc(async (pool: any, email: string) => ({ households: (await pool.query(`SELECT to_jsonb(h) AS row FROM ${householdsTable} h WHERE email = $1`, [email])).rows.map((r: any) => r.row) }));
export const postgresEmails = emailsDoc(async (pool: any, w: string) => ({
  households: (await pool.query(`SELECT jsonb_build_object('id', id, 'email', email) AS row FROM ${householdsTable} WHERE weddings_id = $1`, [Number(w)])).rows.map((r: any) => r.row) as any[],
}));
export const postgresGuests = guestsDoc(async (pool: any, w: string) => ({
  households: (await pool.query(`SELECT id::text AS id, weddings_id::text AS weddings_id, email FROM ${householdsTable} WHERE weddings_id = $1`, [Number(w)])).rows,
}));
export const postgresOpenSeats = openSeatsDoc(async (pool: any) => ({ seats: (await pool.query(`SELECT to_jsonb(s) AS row FROM ${seatsTable} s WHERE NOT kept`)).rows.map((r: any) => r.row) }));
export const postgresMenuCard = menuCardDoc(async (pool: any, id: number) => (await pool.query(
  `SELECT jsonb_build_object('wedding', w.name, 'courses', COALESCE((SELECT jsonb_agg(c.name ORDER BY c.id) FROM ${coursesTable} c WHERE c.weddings_id = w.id), '[]'::jsonb)) AS doc FROM ${weddingsTable} w WHERE w.id = $1`,
  [id])).rows[0]?.doc ?? null);
