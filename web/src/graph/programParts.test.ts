import { describe, expect, it } from "vitest";
import type { Graph } from "../api";
import { Model } from "./model";
import { programModel, programRoots } from "./program";
import { architectureView } from "./views";

// livepnl-producer in miniature: main opens two TCP ports served by one handler; the handler
// submits (transcode, sid, payload) to an executor task that publishes to Kafka. main also
// starts a reader thread that puts Fill records on a queue a writer thread takes from (each
// holds the queue in its own field), and loads topic mappings the task reads.
const graph: Graph = {
  nodes: [
    { id: "mod:livepnl", kind: "module", name: "livepnl" },
    { id: "svc:producer", kind: "service", name: "livepnl-producer", attrs: { module: "mod:livepnl", mainClass: "producer.Main", jar: "producer-1.0.jar", launch: "maven-shade", declaredIn: "pom.xml" } },
    { id: "class:producer.Main", kind: "class", name: "Main", parent: "mod:livepnl" },
    { id: "method:producer.Main#main(String[])", kind: "method", name: "main", parent: "class:producer.Main",
      otel: { "code.namespace": "producer.Main" },
      attrs: { entryPoint: "main", params: [{ name: "args", type: "String[]" }],
        variables: [{ name: "mappings", scope: "field", declaredIn: "field:producer.Mapper#mappings", writes: 1, reads: 0 }] } },
    { id: "class:producer.Mapper", kind: "class", name: "Mapper", parent: "mod:livepnl" },
    { id: "field:producer.Mapper#mappings", kind: "field", name: "mappings", parent: "class:producer.Mapper", attrs: { type: "Map<Integer,String>" } },
    { id: "class:producer.Server", kind: "class", name: "NettySocketServer", parent: "mod:livepnl" },
    { id: "method:producer.Server#start()", kind: "method", name: "start", parent: "class:producer.Server" },
    { id: "class:producer.Handler", kind: "class", name: "ConnectorPacketHandler", parent: "mod:livepnl" },
    { id: "method:producer.Handler#channelRead0(ChannelHandlerContext,ConnectorPacket)", kind: "method", name: "channelRead0", parent: "class:producer.Handler" },
    { id: "ep:5001", kind: "endpoint", name: "TCP :5001", parent: "mod:livepnl", attrs: { protocol: "tcp", openedBy: ["method:producer.Server#start()"], request: { type: "ConnectorPacket" } } },
    { id: "ep:5002", kind: "endpoint", name: "TCP :5002", parent: "mod:livepnl", attrs: { protocol: "tcp", openedBy: ["method:producer.Server#start()"], request: { type: "ConnectorPacket" } } },
    { id: "class:producer.Kafka", kind: "class", name: "KafkaManager", parent: "mod:livepnl" },
    { id: "method:producer.Kafka#submit(int,int,byte[])", kind: "method", name: "submit", parent: "class:producer.Kafka",
      attrs: { doc: "Submit a message for async delivery to Kafka. Retries on failure.", params: [{ name: "transcode", type: "int" }, { name: "sid", type: "int" }, { name: "payload", type: "byte[]" }] } },
    { id: "method:producer.Kafka#lambda@48()", kind: "method", name: "lambda@48", parent: "class:producer.Kafka",
      attrs: { lambda: true, definedIn: "method:producer.Kafka#submit(int,int,byte[])",
        variables: [
          { name: "transcode", scope: "captured", type: "int", declaredIn: "method:producer.Kafka#submit(int,int,byte[])", reads: 1, writes: 0 },
          { name: "sid", scope: "captured", type: "int", declaredIn: "method:producer.Kafka#submit(int,int,byte[])", reads: 1, writes: 0 },
          { name: "payload", scope: "captured", type: "byte[]", declaredIn: "method:producer.Kafka#submit(int,int,byte[])", reads: 1, writes: 0 },
          { name: "mappings", scope: "field", declaredIn: "field:producer.Mapper#mappings", reads: 1, writes: 0 },
        ] } },
    { id: "class:producer.Reader", kind: "class", name: "FillReader", parent: "mod:livepnl" },
    { id: "method:producer.Reader#run()", kind: "method", name: "run", parent: "class:producer.Reader",
      attrs: { entryPoint: "thread", variables: [{ name: "out", scope: "field", declaredIn: "field:producer.Reader#out", reads: 1, writes: 1 }],
        controlFlow: [{ k: "do", items: [{ text: "out.put(fill);" }] }] } },
    { id: "field:producer.Reader#out", kind: "field", name: "out", parent: "class:producer.Reader", attrs: { type: "BlockingQueue<Fill>" } },
    { id: "class:producer.Writer", kind: "class", name: "FillPersistenceThread", parent: "mod:livepnl" },
    { id: "method:producer.Writer#run()", kind: "method", name: "run", parent: "class:producer.Writer",
      attrs: { entryPoint: "thread", variables: [{ name: "queue", scope: "field", declaredIn: "field:producer.Writer#queue", reads: 1, writes: 1 }],
        controlFlow: [{ k: "loop", kind: "while", text: "while running", body: [{ k: "do", items: [{ text: "Fill f = queue.take();" }] }] }] } },
    { id: "field:producer.Writer#queue", kind: "field", name: "queue", parent: "class:producer.Writer", attrs: { type: "BlockingQueue<Fill>" } },
    { id: "class:producer.Ticks", kind: "class", name: "TickConsumer", parent: "mod:livepnl" },
    { id: "method:producer.Ticks#<init>()", kind: "method", name: "<init>", parent: "class:producer.Ticks" },
    { id: "method:producer.Ticks#run()", kind: "method", name: "run", parent: "class:producer.Ticks", attrs: { entryPoint: "thread" } },
    { id: "topic:ticks", kind: "topic", name: "ticks", otel: { "messaging.system": "kafka" } },
    { id: "topic:fills", kind: "topic", name: "fills", otel: { "messaging.system": "kafka" } },
    { id: "topic:prices", kind: "topic", name: "prices", otel: { "messaging.system": "kafka" } },
    { id: "topic:live", kind: "topic", name: "live-prices", otel: { "messaging.system": "kafka" } },
    { id: "db:pg", kind: "database", name: "ledger", otel: { "db.system": "postgresql" } },
    { id: "table:fills", kind: "table", name: "fills", parent: "db:pg" },
  ],
  edges: [
    { source: "svc:producer", target: "method:producer.Main#main(String[])", kind: "runs" },
    { source: "method:producer.Main#main(String[])", target: "method:producer.Server#start()", kind: "calls" },
    { source: "method:producer.Main#main(String[])", target: "method:producer.Ticks#<init>()", kind: "calls" },
    { source: "method:producer.Ticks#<init>()", target: "topic:ticks", kind: "consumes", attrs: { payloads: [{ type: "Tick" }] } },
    { source: "method:producer.Main#main(String[])", target: "method:producer.Reader#run()", kind: "calls", attrs: { async: "thread" } },
    { source: "method:producer.Main#main(String[])", target: "method:producer.Writer#run()", kind: "calls", attrs: { async: "thread" } },
    { source: "ep:5001", target: "method:producer.Handler#channelRead0(ChannelHandlerContext,ConnectorPacket)", kind: "handles" },
    { source: "ep:5002", target: "method:producer.Handler#channelRead0(ChannelHandlerContext,ConnectorPacket)", kind: "handles" },
    { source: "method:producer.Handler#channelRead0(ChannelHandlerContext,ConnectorPacket)", target: "method:producer.Kafka#submit(int,int,byte[])", kind: "calls" },
    { source: "method:producer.Kafka#submit(int,int,byte[])", target: "method:producer.Kafka#lambda@48()", kind: "calls", attrs: { async: "executor" } },
    { source: "method:producer.Kafka#lambda@48()", target: "topic:fills", kind: "publishes", attrs: { payloads: [{ type: "byte[]" }] } },
    { source: "method:producer.Kafka#lambda@48()", target: "topic:prices", kind: "publishes", attrs: { payloads: [{ type: "byte[]" }] } },
    { source: "method:producer.Kafka#lambda@48()", target: "topic:live", kind: "publishes", attrs: { payloads: [{ type: "byte[]" }] } },
    { source: "method:producer.Writer#run()", target: "table:fills", kind: "writes", attrs: { payloads: [{ type: "Fill" }] } },
    { source: "method:producer.Writer#run()", target: "table:fills", kind: "reads", attrs: { responses: [{ type: "Fill" }] } },
  ],
};

describe("a program read as one file", () => {
  const m = new Model(graph);
  const root = programRoots(m)[0];
  const { view, outline } = programModel(m, root.id);
  const box = (start: string) => view.nodes.find((n) => n.id === `prog:${start}`);
  const between = (a: string, b: string) => view.edges.find((e) => e.source === `prog:${a}` && e.target === `prog:${b}`);

  it("lists programs by name, starting at the main they run", () => {
    expect(root).toMatchObject({ id: "method:producer.Main#main(String[])", service: "livepnl-producer", label: "livepnl-producer · Main.main" });
  });

  it("names each part by what it does; ports served by one handler are one part", () => {
    expect(box("ep:5001")?.label).toMatch(/^\d\. Receive ConnectorPacket$/);
    expect(box("ep:5001")?.sub).toBe("socket server · :5001, :5002 · ConnectorPacketHandler.channelRead0");
    expect(box("ep:5002")).toBeUndefined();
    expect(box("method:producer.Kafka#lambda@48()")?.label).toMatch(/^\d\. Publish to Kafka \(3 topics\)$/);
    expect(box("method:producer.Kafka#lambda@48()")?.sections?.[0][0].text).toBe("“Submit a message for async delivery to Kafka”");
    expect(box("method:producer.Writer#run()")?.label).toMatch(/^\d\. Fill persistence thread · write fills$/);
  });

  it("draws the data one part hands the next: captured arguments, a queue's element type, shared state", () => {
    const pass = between("ep:5001", "method:producer.Kafka#lambda@48()");
    expect(pass?.label).toBe("transcode: int, sid: int, payload: byte[]");
    expect(pass?.sublabel).toBe("starts · via KafkaManager.submit");
    expect(pass?.style).toBe("data");
    const q = between("method:producer.Reader#run()", "method:producer.Writer#run()");
    expect(q?.label).toBe("Fill");
    expect(q?.sublabel).toBe("queue out → queue");
    const shared = between("method:producer.Main#main(String[])", "method:producer.Kafka#lambda@48()");
    expect(shared?.label).toBe("mappings: Map<Integer,String>");
    expect(shared?.conditional).toBe(true); // dashed: state, not a message
    expect(between("method:producer.Main#main(String[])", "ep:5001")?.label).toBe("opens :5001, :5002");
  });

  it("a thread object start-up creates is its own part, and its constructor's subscription is that part's", () => {
    expect(box("method:producer.Ticks#run()")?.label).toMatch(/^\d\. Tick consumer · consume ticks$/);
    expect(between("method:producer.Main#main(String[])", "method:producer.Ticks#run()")?.label).toBe("creates");
    expect(box("method:producer.Main#main(String[])")?.label).toBe("1. Start-up");
    expect(view.edges.some((e) => e.source === "in:topic:ticks" && e.target === "prog:method:producer.Ticks#run()")).toBe(true);
    expect(view.edges.some((e) => e.source === "in:topic:ticks" && e.target === "prog:method:producer.Main#main(String[])")).toBe(false);
  });

  it("numbers parts in the order data moves: start-up, then each part after what feeds it", () => {
    const n = (id: string) => outline!.parts.find((p) => p.id === `prog:${id}`)!.n;
    expect(n("method:producer.Main#main(String[])")).toBe(1);
    expect(n("ep:5001")).toBeLessThan(n("method:producer.Kafka#lambda@48()"));
    expect(n("method:producer.Reader#run()")).toBeLessThan(n("method:producer.Writer#run()"));
  });

  it("gives the same program as an outline: how it starts, then each part's inputs and outputs", () => {
    expect(outline).toMatchObject({
      title: "livepnl-producer", launch: "java -jar producer-1.0.jar (maven-shade, pom.xml)", entry: "producer.Main.main(String[])",
    });
    const receive = outline!.parts.find((p) => p.id === "prog:ep:5001")!;
    expect(receive.inputs).toEqual([
      expect.objectContaining({ label: "1. Start-up", part: 1, data: "opens :5001, :5002", control: true }),
      expect.objectContaining({ label: "Socket clients (external)", data: "ConnectorPacket", via: "TCP :5001, TCP :5002" }),
    ]);
    const task = outline!.parts.find((p) => p.id === "prog:method:producer.Kafka#lambda@48()")!;
    expect(task.inputs.map((i) => [i.part, i.data])).toEqual(expect.arrayContaining([[receive.n, "transcode: int, sid: int, payload: byte[]"]]));
    // three topics of one broker carrying the same data: one line in the outline
    expect(task.outputs).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Kafka (3): fills, prices, live-prices", data: "byte[]" })]));
    expect(task.kind).toBe("task on an executor");
    expect(task.code).toBe("KafkaManager.lambda@48");
  });
});

describe("every diagram follows the data", () => {
  it("draws a read from the store to the reader, and a store read and written as one line with two arrowheads", () => {
    const m = new Model({
      nodes: [
        { id: "svc:a", kind: "service", name: "a" },
        { id: "svc:b", kind: "service", name: "b" },
        { id: "m:a", kind: "method", name: "x", parent: "svc:a" },
        { id: "m:b", kind: "method", name: "y", parent: "svc:b" },
        { id: "db:1", kind: "database", name: "one" },
        { id: "db:2", kind: "database", name: "two" },
      ],
      edges: [
        { source: "m:a", target: "db:1", kind: "reads" },
        { source: "m:b", target: "db:2", kind: "reads" },
        { source: "m:b", target: "db:2", kind: "writes" },
      ],
    });
    const edges = architectureView(m).edges;
    expect(edges.find((e) => e.source === "db:1" && e.target === "svc:a")?.label).toBe("read by");
    const rw = edges.filter((e) => [e.source, e.target].sort().join() === "db:2,svc:b");
    expect(rw).toHaveLength(1);
    expect(rw[0]).toMatchObject({ source: "svc:b", target: "db:2", label: "reads & writes", both: true });
  });
});

describe("work written against an interface", () => {
  it("follows a call to an interface method into the class implementing it", () => {
    const m = new Model({
      nodes: [
        { id: "svc:p", kind: "service", name: "fill-producer" },
        { id: "class:M", kind: "class", name: "Main", parent: "svc:p" },
        { id: "method:M#main()", kind: "method", name: "main", parent: "class:M", attrs: { entryPoint: "main" } },
        { id: "method:M#serve()", kind: "method", name: "serve", parent: "class:M" },
        { id: "class:H", kind: "class", name: "FillOnlyConnectorHandler", parent: "svc:p" },
        { id: "method:H#channelRead0()", kind: "method", name: "channelRead0", parent: "class:H" },
        { id: "class:S", kind: "interface", name: "FillMessageSink", parent: "svc:p" },
        { id: "method:S#submit(int,byte[])", kind: "method", name: "submit", parent: "class:S", attrs: { abstract: true } },
        { id: "class:K", kind: "class", name: "FillKafkaManager", parent: "svc:p" },
        { id: "method:K#submit(int,byte[])", kind: "method", name: "submit", parent: "class:K" },
        { id: "ep:6001", kind: "endpoint", name: "TCP :6001", parent: "svc:p", attrs: { protocol: "tcp", openedBy: ["method:M#serve()"], request: { type: "ConnectorPacket" } } },
        { id: "topic:fills", kind: "topic", name: "fills-dropcopy", otel: { "messaging.system": "kafka" } },
      ],
      edges: [
        { source: "method:M#main()", target: "method:M#serve()", kind: "calls" },
        { source: "ep:6001", target: "method:H#channelRead0()", kind: "handles" },
        { source: "method:H#channelRead0()", target: "method:S#submit(int,byte[])", kind: "calls" },
        { source: "class:K", target: "class:S", kind: "implements" },
        { source: "method:K#submit(int,byte[])", target: "topic:fills", kind: "publishes", attrs: { payloads: [{ type: "byte[]" }] } },
      ],
    });
    const { view } = programModel(m, "method:M#main()");
    expect(view.nodes.find((n) => n.id === "prog:ep:6001")?.label).toMatch(/Receive ConnectorPacket/);
    expect(view.edges.some((e) => e.source === "prog:ep:6001" && e.target === "out:topic:fills" && e.label === "byte[]")).toBe(true);
  });
});
