import { LIMIT, mode } from "./config";

let total = 0;
const seen: string[] = [];

/**
 * Counts orders and remembers recent ones.
 *
 * Second paragraph is left out.
 */
export class Counter {
  static instances = 0;
  private readonly recent: string[] = [];

  constructor(private name: string) {
    Counter.instances++;
  }

  /** Adds an order to the {@link recent} list. */
  add(order: string, qty: number): number {
    const sum = qty * 2;
    total += sum;
    this.recent.push(order);
    if (sum > LIMIT && mode === "fast") {
      this.name = order;
    }
    const name = "shadow";
    return sum + name.length + seen.length;
  }
}

export function startTimer(tag: string) {
  setInterval(() => {
    seen.push(tag);
  }, 1000);
  return { tag };
}
