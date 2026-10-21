import { parentPort } from "node:worker_threads";
import { rollup } from "./db";

parentPort?.on("message", async () => {
  await rollup();
});
