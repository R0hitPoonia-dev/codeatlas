package dev.codeatlas.java;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** CodeAtlas IR v1 model (see ir/schema/ir.v1.schema.json) plus a de-duplicating builder. */
final class Ir {
    private Ir() {}

    @JsonInclude(JsonInclude.Include.NON_EMPTY)
    record Location(String file, Integer startLine, Integer endLine) {}

    @JsonInclude(JsonInclude.Include.NON_EMPTY)
    static final class Node {
        public final String id;
        public final String kind;
        public final String name;
        public String qualifiedName;
        public String parent;
        public String language;
        public Location location;
        public final Map<String, String> otel = new LinkedHashMap<>();
        public final Map<String, Object> attrs = new LinkedHashMap<>();

        Node(String id, String kind, String name) {
            this.id = id;
            this.kind = kind;
            this.name = name;
        }
    }

    @JsonInclude(JsonInclude.Include.NON_EMPTY)
    static final class Edge {
        public final String source;
        public final String target;
        public final String kind;
        public final List<Location> locations = new ArrayList<>();
        public final Map<String, Object> attrs = new LinkedHashMap<>();

        Edge(String source, String target, String kind) {
            this.source = source;
            this.target = target;
            this.kind = kind;
        }
    }

    record Analyzer(String name, String version) {}

    @JsonInclude(JsonInclude.Include.NON_EMPTY)
    record Source(String repo, String commit, String branch, Analyzer analyzer, String generatedAt) {}

    record Document(String irVersion, Source source, List<Node> nodes, List<Edge> edges) {}

    /** Collects nodes and edges; same id / same (source, target, kind) are merged. */
    static final class Builder {
        private static final int MAX_LOCATIONS_PER_EDGE = 20;
        private final Map<String, Node> nodes = new LinkedHashMap<>();
        private final Map<String, Edge> edges = new LinkedHashMap<>();

        Node node(String id, String kind, String name) {
            return nodes.computeIfAbsent(id, k -> new Node(id, kind, name));
        }

        /** Every node so far, in creation order. */
        java.util.Collection<Node> nodes() {
            return java.util.Collections.unmodifiableCollection(nodes.values());
        }

        Node get(String id) {
            return nodes.get(id);
        }

        boolean has(String id) {
            return nodes.containsKey(id);
        }

        Edge edge(String source, String target, String kind) {
            return edges.computeIfAbsent(source + "\u0000" + target + "\u0000" + kind,
                k -> new Edge(source, target, kind));
        }

        Edge edge(String source, String target, String kind, Location at) {
            Edge e = edge(source, target, kind);
            if (at != null && e.locations.size() < MAX_LOCATIONS_PER_EDGE && !e.locations.contains(at)) {
                e.locations.add(at);
            }
            return e;
        }

        /**
         * Like {@link #edge(String, String, String, Location)}, also recording the conditions the
         * occurrence runs under: attrs.conditions lists distinct guard chains ("for each x in xs ›
         * if ok"), attrs.unconditional is true if any occurrence always runs.
         */
        @SuppressWarnings("unchecked")
        Edge edge(String source, String target, String kind, Location at, List<String> guards) {
            Edge e = edge(source, target, kind, at);
            if (guards.isEmpty()) {
                e.attrs.put("unconditional", true);
            } else {
                List<String> conditions = (List<String>) e.attrs.computeIfAbsent("conditions", k -> new ArrayList<String>());
                String chain = String.join(" › ", guards);
                if (conditions.size() < 10 && !conditions.contains(chain)) {
                    conditions.add(chain);
                }
            }
            return e;
        }

        /** Builds the document, dropping edges/parents that reference unknown nodes. */
        Document build(Source source) {
            List<Edge> kept = new ArrayList<>();
            for (Edge e : edges.values()) {
                if (nodes.containsKey(e.source) && nodes.containsKey(e.target) && !e.source.equals(e.target)) {
                    kept.add(e);
                }
            }
            for (Node n : nodes.values()) {
                if (n.parent != null && (!nodes.containsKey(n.parent) || n.parent.equals(n.id))) {
                    n.parent = null;
                }
            }
            return new Document("1", source, new ArrayList<>(nodes.values()), kept);
        }
    }

    static String now() {
        return Instant.now().toString();
    }
}
