// Creates or updates the database tables. The server also does this on start.
import { migrate, pool } from "./db.js";

await migrate();
await pool.end();
console.log("Database is up to date.");
