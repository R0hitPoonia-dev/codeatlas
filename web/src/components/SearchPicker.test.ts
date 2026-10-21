import { describe, expect, it } from "vitest";
import { filterOptions, PickerOption } from "./SearchPicker";

const opts: PickerOption[] = [
  { id: "1", label: "notifyOrderPlaced(string, string)", hint: "notifications-service · src/notifications.ts:10" },
  { id: "2", label: "OrderService.new(OrderRepository, KafkaTemplate<String,OrderPlacedEvent>)", hint: "orders-service" },
  { id: "3", label: "OrderService.place(Order, String)", hint: "orders-service · OrderService.java:40" },
  { id: "4", label: "OrdersGateway.placeOrder(CheckoutRequest)", hint: "storefront-bff" },
  { id: "5", label: "StockService.reserve(String, int)", hint: "inventory-service · StockService.java:16" },
];

describe("filterOptions", () => {
  it("returns everything for an empty query", () => {
    expect(filterOptions(opts, "  ")).toHaveLength(5);
  });

  it("ranks name-start matches before substring, parameter and hint matches", () => {
    expect(filterOptions(opts, "place").map((o) => o.id)).toEqual(["3", "4", "1", "2"]);
  });

  it("needs every word, in any order, matching label or hint", () => {
    expect(filterOptions(opts, "orders place").map((o) => o.id)).toEqual(["3", "4", "2"]);
    expect(filterOptions(opts, "inventory reserve").map((o) => o.id)).toEqual(["5"]);
    expect(filterOptions(opts, "nothing-like-this")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(filterOptions(opts, "STOCKSERVICE").map((o) => o.id)).toEqual(["5"]);
  });
});
