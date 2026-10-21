import { describe, expect, it } from "vitest";
import type { Graph } from "../api";
import { entryPoints, systemDataFlow } from "./dataflow";
import { architectureView, componentsView } from "./views";
import { Model } from "./model";

// One module, two jars. producer publishes `fills`; consumer reads them and a table.
// Both call a shared logger that writes the database.
const graph: Graph = {
  nodes: [
    { id: "mod:livepnl", kind: "module", name: "livepnl", attrs: { path: "engine" } },
    { id: "svc:livepnl-producer", kind: "service", name: "livepnl-producer", attrs: { path: "engine", module: "mod:livepnl", jar: "producer-1.2.jar", mainClass: "producer.Main", launch: "maven-shade" } },
    { id: "svc:livepnl-consumer", kind: "service", name: "livepnl-consumer", attrs: { path: "engine", module: "mod:livepnl", jar: "consumer-1.2.jar", mainClass: "consumer.Main", launch: "maven-shade" } },
    { id: "pkg:producer", kind: "package", name: "producer", parent: "mod:livepnl" },
    { id: "class:P", kind: "class", name: "Main", parent: "pkg:producer" },
    { id: "m:pmain", kind: "method", name: "main", parent: "class:P", attrs: { entryPoint: "main" } },
    { id: "m:send", kind: "method", name: "send", parent: "class:P" },
    { id: "pkg:consumer", kind: "package", name: "consumer", parent: "mod:livepnl" },
    { id: "class:C", kind: "class", name: "Main", parent: "pkg:consumer" },
    { id: "m:cmain", kind: "method", name: "main", parent: "class:C", attrs: { entryPoint: "main" } },
    { id: "m:take", kind: "method", name: "take", parent: "class:C" },
    { id: "pkg:shared", kind: "package", name: "shared", parent: "mod:livepnl" },
    { id: "class:S", kind: "class", name: "Log", parent: "pkg:shared" },
    { id: "m:log", kind: "method", name: "log", parent: "class:S" },
    { id: "topic:fills", kind: "topic", name: "fills" },
    { id: "db:pg", kind: "database", name: "pg" },
    { id: "ep:tcp", kind: "endpoint", name: "TCP :7001", parent: "mod:livepnl", attrs: { protocol: "tcp", openedBy: ["m:pmain"] } },
  ],
  edges: [
    { source: "svc:livepnl-producer", target: "m:pmain", kind: "runs" },
    { source: "svc:livepnl-consumer", target: "m:cmain", kind: "runs" },
    { source: "m:pmain", target: "m:send", kind: "calls" },
    { source: "m:send", target: "m:log", kind: "calls" },
    { source: "m:send", target: "topic:fills", kind: "publishes" },
    { source: "m:cmain", target: "m:take", kind: "calls" },
    { source: "m:take", target: "m:log", kind: "calls" },
    { source: "m:take", target: "topic:fills", kind: "consumes" },
    { source: "m:log", target: "db:pg", kind: "writes" },
  ],
};

describe("several programs in one module", () => {
  const m = new Model(graph);

  it("credits each program with the code its main reaches, including code both reach", () => {
    const arch = architectureView(m);
    const ids = arch.nodes.map((n) => n.id);
    expect(ids).toContain("svc:livepnl-producer");
    expect(ids).toContain("svc:livepnl-consumer");
    expect(ids).not.toContain("mod:livepnl");
    const linked = (source: string, target: string) => arch.edges.some((e) => e.source === source && e.target === target);
    expect(linked("svc:livepnl-producer", "topic:fills")).toBe(true);
    expect(linked("topic:fills", "svc:livepnl-consumer")).toBe(true);
    expect(linked("svc:livepnl-producer", "db:pg")).toBe(true);
    expect(linked("svc:livepnl-consumer", "db:pg")).toBe(true);
  });

  it("level 1 draws the same split", () => {
    const v = systemDataFlow(m);
    const ends = v.edges.map((e) => `${e.source}->${e.target}`);
    expect(ends).toContain("svc:livepnl-producer->topic:fills");
    expect(ends).toContain("topic:fills->svc:livepnl-consumer");
    expect(ends.filter((e) => e.startsWith("svc:livepnl-producer->db:pg")).length).toBe(1);
  });

  it("a program's entry points are what it starts, not its sibling's", () => {
    expect(entryPoints(m, "svc:livepnl-producer").map((e) => e.kind).sort()).toEqual(["main", "socket"]);
    expect(entryPoints(m, "svc:livepnl-consumer").map((e) => `${e.kind}:${e.label}`)).toEqual(["consumer:on fills", "main:Main.main"]);
  });

  it("inside a program shows the packages it reaches", () => {
    const v = componentsView(m, "svc:livepnl-producer");
    const ids = v.nodes.map((n) => n.id);
    expect(ids).toContain("pkg:producer");
    expect(ids).toContain("pkg:shared");
    expect(ids).not.toContain("pkg:consumer");
  });
});

// consumer.Main builds KafkaConsumer workers and hands them to a pool with
// `consumers.forEach(pool::submit)` (no call edge to run()); the worker dispatches through
// a Handler interface to FillHandler, which reads Redis.
describe("work a program creates or dispatches through an interface", () => {
  const m = new Model({
    nodes: [
      { id: "mod:livepnl", kind: "module", name: "livepnl", attrs: { path: "." } },
      { id: "svc:livepnl-consumer", kind: "service", name: "livepnl-consumer", attrs: { path: ".", module: "mod:livepnl" } },
      { id: "svc:livepnl-producer", kind: "service", name: "livepnl-producer", attrs: { path: ".", module: "mod:livepnl" } },
      { id: "class:consumer.Main", kind: "class", name: "Main", parent: "mod:livepnl" },
      { id: "method:consumer.Main#main(String[])", kind: "method", name: "main", parent: "class:consumer.Main" },
      { id: "class:producer.Main", kind: "class", name: "Main", parent: "mod:livepnl" },
      { id: "method:producer.Main#main(String[])", kind: "method", name: "main", parent: "class:producer.Main" },
      { id: "class:k.KafkaConsumer", kind: "class", name: "KafkaConsumer", parent: "mod:livepnl" },
      { id: "method:k.KafkaConsumer#<init>(Config)", kind: "method", name: "<init>", parent: "class:k.KafkaConsumer", attrs: { constructor: true } },
      { id: "method:k.KafkaConsumer#run()", kind: "method", name: "run", parent: "class:k.KafkaConsumer", attrs: { entryPoint: "thread" } },
      { id: "class:h.Handler", kind: "interface", name: "Handler", parent: "mod:livepnl" },
      { id: "method:h.Handler#handle(byte[])", kind: "method", name: "handle", parent: "class:h.Handler", attrs: { abstract: true } },
      { id: "class:h.FillHandler", kind: "class", name: "FillHandler", parent: "mod:livepnl" },
      { id: "method:h.FillHandler#handle(byte[])", kind: "method", name: "handle", parent: "class:h.FillHandler" },
      { id: "db:redis", kind: "database", name: "redis" },
    ],
    edges: [
      { source: "svc:livepnl-consumer", target: "method:consumer.Main#main(String[])", kind: "runs" },
      { source: "svc:livepnl-producer", target: "method:producer.Main#main(String[])", kind: "runs" },
      { source: "method:consumer.Main#main(String[])", target: "method:k.KafkaConsumer#<init>(Config)", kind: "calls" },
      { source: "method:k.KafkaConsumer#run()", target: "method:h.Handler#handle(byte[])", kind: "calls" },
      { source: "class:h.FillHandler", target: "class:h.Handler", kind: "implements" },
      { source: "method:h.FillHandler#handle(byte[])", target: "db:redis", kind: "reads" },
    ],
  });

  it("credits the worker's thread and the interface's implementation to the program that creates it", () => {
    expect(m.appsOf("method:k.KafkaConsumer#run()").map((n) => n.id)).toEqual(["svc:livepnl-consumer"]);
    expect(m.appsOf("method:h.FillHandler#handle(byte[])").map((n) => n.id)).toEqual(["svc:livepnl-consumer"]);
    const arch = architectureView(m);
    expect(arch.edges.some((e) => e.source === "db:redis" && e.target === "svc:livepnl-consumer")).toBe(true); // read: store -> reader
    expect(arch.edges.some((e) => e.target === "svc:livepnl-producer" || e.source === "svc:livepnl-producer")).toBe(false);
    expect(arch.nodes.map((n) => n.id)).not.toContain("mod:livepnl");
  });
});

// Netty calls channelActive on the handler whose channelRead0 the producer's server reaches;
// an unused helper sits in a class nobody reaches.
describe("code no main reaches directly", () => {
  const m = new Model({
    nodes: [
      { id: "mod:livepnl", kind: "module", name: "livepnl" },
      { id: "svc:producer", kind: "service", name: "producer", attrs: { module: "mod:livepnl" } },
      { id: "svc:consumer", kind: "service", name: "consumer", attrs: { module: "mod:livepnl" } },
      { id: "class:P", kind: "class", name: "Main", parent: "mod:livepnl" },
      { id: "method:P#main()", kind: "method", name: "main", parent: "class:P" },
      { id: "class:C", kind: "class", name: "Main", parent: "mod:livepnl" },
      { id: "method:C#main()", kind: "method", name: "main", parent: "class:C" },
      { id: "class:H", kind: "class", name: "Handler", parent: "mod:livepnl" },
      { id: "method:H#channelRead0()", kind: "method", name: "channelRead0", parent: "class:H" },
      { id: "method:H#channelActive()", kind: "method", name: "channelActive", parent: "class:H" },
      { id: "class:Dead", kind: "class", name: "Dead", parent: "mod:livepnl" },
      { id: "method:Dead#latest()", kind: "method", name: "latest", parent: "class:Dead" },
      { id: "db:redis", kind: "database", name: "redis" },
      { id: "db:pg", kind: "database", name: "pg" },
    ],
    edges: [
      { source: "svc:producer", target: "method:P#main()", kind: "runs" },
      { source: "svc:consumer", target: "method:C#main()", kind: "runs" },
      { source: "method:P#main()", target: "method:H#channelRead0()", kind: "calls" },
      { source: "method:H#channelActive()", target: "db:redis", kind: "writes" },
      { source: "method:H#channelActive()", target: "method:C#main()", kind: "calls" },
      { source: "method:Dead#latest()", target: "db:pg", kind: "reads" },
    ],
  });

  it("a method nothing calls runs in the programs that use its class; unused code stays with the module", () => {
    expect(m.appsOf("method:H#channelActive()").map((n) => n.id)).toEqual(["svc:producer"]);
    expect(m.appsOf("method:Dead#latest()").map((n) => n.id)).toEqual(["mod:livepnl"]);
    const arch = architectureView(m);
    const linked = (s: string, t: string) => arch.edges.some((e) => e.source === s && e.target === t);
    expect(linked("svc:producer", "db:redis")).toBe(true);
    expect(linked("db:pg", "mod:livepnl")).toBe(true); // read: store -> reader
    expect(linked("svc:producer", "svc:consumer")).toBe(false); // a call inside the module is not a link
    expect(arch.nodes.find((n) => n.id === "svc:producer")?.sub).toBe("from livepnl");
  });
});
