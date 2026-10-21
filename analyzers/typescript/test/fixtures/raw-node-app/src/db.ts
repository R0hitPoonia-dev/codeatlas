import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ROLLUPS = "event_rollups";

export interface EventRow {
  id: string;
  userEmail: string;
  payload: string;
}

export async function saveEvent(e: EventRow) {
  await pool.query("INSERT INTO events (id, user_email, payload) VALUES ($1, $2, $3)", [e.id, e.userEmail, e.payload]);
}

export async function recent() {
  const { rows } = await pool.query(`SELECT id, user_email FROM events WHERE created_at > now() - interval '1 hour'`);
  return rows;
}

export async function rollup() {
  await pool.query(`INSERT INTO ${ROLLUPS} (hour, n) SELECT date_trunc('hour', created_at), count(*) FROM events GROUP BY 1`);
}
