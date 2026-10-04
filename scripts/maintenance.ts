/** Scheduled maintenance entry point (production: run hourly from the platform scheduler). See app/lib/maintenance.server.ts. */
import { runMaintenance } from "../app/lib/maintenance.server";

const report = await runMaintenance();
console.log(JSON.stringify({ maintenance: report, at: new Date().toISOString() }));
process.exit(0);
