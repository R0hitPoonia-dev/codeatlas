import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL ?? "redis://cache:6379");

export async function remember(userId: string, session: object) {
  await redis.set(`session:${userId}`, JSON.stringify(session));
  await redis.publish("sessions", userId);
}

export async function lookup(userId: string) {
  return redis.get(`session:${userId}`);
}
