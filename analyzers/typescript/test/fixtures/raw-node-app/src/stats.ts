let count = 0;

export function flushStats() {
  console.log("events", count);
  count = 0;
}
