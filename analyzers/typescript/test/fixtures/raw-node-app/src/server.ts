import http from "node:http";
import net from "node:net";
import { WebSocketServer } from "ws";
import { recent } from "./db";
import { lookup, remember } from "./cache";
import { startQueue } from "./queue";

const TCP_PORT = 9000;

export function startServers() {
  net.createServer(onConnection).listen(TCP_PORT);
  const wss = new WebSocketServer({ port: 9001 });
  wss.on("connection", onSocket);
  http.createServer(handleHttp).listen(8081);
  startQueue();
}

function onConnection(socket: net.Socket) {
  socket.on("data", async (buf) => {
    await remember(buf.toString(), { at: Date.now() });
  });
}

function onSocket(ws: { send(s: string): void }) {
  recent().then((rows) => ws.send(JSON.stringify(rows)));
}

async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
  res.end(await lookup(req.url ?? ""));
}
