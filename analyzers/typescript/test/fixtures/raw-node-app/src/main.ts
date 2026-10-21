import { Worker } from "node:worker_threads";
import cron from "node-cron";
import { rollup } from "./db";
import { startServers } from "./server";
import { flushStats } from "./stats";

startServers();
setInterval(flushStats, 60_000);
cron.schedule("0 * * * *", () => rollup());
new Worker(new URL("./worker.js", import.meta.url));
