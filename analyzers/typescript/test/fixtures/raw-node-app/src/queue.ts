import amqp from "amqplib";
import { saveEvent, EventRow } from "./db";

export async function startQueue() {
  const conn = await amqp.connect("amqp://mq");
  const channel = await conn.createChannel();
  await channel.consume("incoming-events", async (msg) => {
    if (!msg) return;
    const row: EventRow = JSON.parse(msg.content.toString());
    await saveEvent(row);
    channel.sendToQueue("emails", Buffer.from(JSON.stringify({ to: row.userEmail })));
  });
}
