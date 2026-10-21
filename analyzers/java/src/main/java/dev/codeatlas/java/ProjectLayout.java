package dev.codeatlas.java;

import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;

/** Finds build modules (Maven/Gradle) and reads the bits of their config we need. */
final class ProjectLayout {

    static final Set<String> SKIP_DIRS = Set.of(".git", "target", "build", "out", "node_modules", ".idea", ".gradle", "bin");

    /**
     * A build module with Java sources, or (sourceRoots empty) one that only packages code from
     * other modules into a runnable jar. launches = the main classes its build declares.
     */
    record Module(String name, String path, Path dir, List<Path> sourceRoots, String appName,
                  String dbSystem, String dbHost, String dbName, String redisHost, Map<String, String> config,
                  Map<String, List<String>> configFiles, List<Launches.Launch> launches) {}

    private ProjectLayout() {}

    static List<Module> discover(Path root) throws IOException {
        Map<Path, List<Path>> moduleDirs = new java.util.LinkedHashMap<>(); // module dir -> its main source roots
        Map<Path, List<Launches.Launch>> launches = new java.util.HashMap<>();
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                if (!dir.equals(root) && SKIP_DIRS.contains(dir.getFileName().toString())) {
                    return FileVisitResult.SKIP_SUBTREE;
                }
                if (isBuildModule(dir)) {
                    Path src = sourceRoot(root, dir);
                    List<Launches.Launch> declared = Launches.of(root, dir);
                    if (src != null || !declared.isEmpty()) {
                        moduleDirs.put(dir, src != null ? List.of(src) : List.of());
                        launches.put(dir, declared);
                    }
                }
                return FileVisitResult.CONTINUE;
            }
        });

        List<Module> modules = new ArrayList<>();
        moduleDirs.forEach((dir, src) -> modules.add(load(root, dir, src, launches.get(dir))));
        if (modules.stream().allMatch(m -> m.sourceRoots().isEmpty()) && containsJava(root)) {
            // No recognised build layout: treat the whole repo as one module.
            modules.add(load(root, root, List.of(root), Launches.of(root, root)));
        }
        return modules;
    }

    /**
     * Where a module's main Java sources are: Maven/Gradle's src/main/java, or the
     * {@code <build><sourceDirectory>} a Maven pom sets (itself or a parent pom above it, e.g.
     * {@code <sourceDirectory>src</sourceDirectory>} for code kept straight in src/).
     */
    static Path sourceRoot(Path root, Path dir) {
        Path standard = dir.resolve("src/main/java");
        if (Files.isDirectory(standard)) {
            return standard;
        }
        for (Path p = dir; p != null && p.startsWith(root); p = p.getParent()) {
            String declared = mavenSourceDirectory(p.resolve("pom.xml"));
            if (declared == null) {
                continue;
            }
            // relative to the module being built, like Maven resolves an inherited ${basedir}
            String rel = declared.replace("${project.basedir}/", "").replace("${basedir}/", "");
            Path src = dir.resolve(rel).normalize();
            return Files.isDirectory(src) && hasJava(src) ? src : null;
        }
        return null;
    }

    private static boolean hasJava(Path dir) {
        try (var s = Files.walk(dir, 12)) {
            return s.anyMatch(p -> p.toString().endsWith(".java"));
        } catch (IOException e) {
            return false;
        }
    }

    /** The {@code <build><sourceDirectory>} of a pom, if it sets one. */
    private static String mavenSourceDirectory(Path pom) {
        if (!Files.exists(pom)) {
            return null;
        }
        try {
            var factory = DocumentBuilderFactory.newInstance();
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setExpandEntityReferences(false);
            var doc = factory.newDocumentBuilder().parse(pom.toFile());
            for (Node n = doc.getDocumentElement().getFirstChild(); n != null; n = n.getNextSibling()) {
                if (n instanceof Element build && build.getTagName().equals("build")) {
                    for (Node c = build.getFirstChild(); c != null; c = c.getNextSibling()) {
                        if (c instanceof Element e && e.getTagName().equals("sourceDirectory") && !e.getTextContent().isBlank()) {
                            return e.getTextContent().trim();
                        }
                    }
                }
            }
        } catch (Exception ignored) {
            // unreadable pom: standard layout only
        }
        return null;
    }

    private static boolean isBuildModule(Path dir) {
        return Files.exists(dir.resolve("pom.xml")) || Files.exists(dir.resolve("build.gradle"))
            || Files.exists(dir.resolve("build.gradle.kts"));
    }

    private static boolean containsJava(Path root) throws IOException {
        try (var s = Files.walk(root)) {
            return s.anyMatch(p -> p.toString().endsWith(".java"));
        }
    }

    private static Module load(Path root, Path dir, List<Path> sourceRoots, List<Launches.Launch> launches) {
        String rel = root.relativize(dir).toString().replace('\\', '/');
        if (rel.isEmpty()) {
            rel = ".";
        }
        Map<String, String> props = configProperties(dir.resolve("src/main/resources"));
        String artifact = artifactId(dir.resolve("pom.xml"));
        String dirName = dir.getFileName() == null ? "root" : dir.getFileName().toString();
        String name = artifact != null ? artifact : dirName;
        String appName = props.getOrDefault("spring.application.name", name);

        String dbSystem = null;
        String dbHost = null;
        String dbName = null;
        // Spring's datasource first, else the first JDBC URL in any config file (db.url=jdbc:...)
        String url = props.get("spring.datasource.url");
        if (url == null) {
            url = props.values().stream().filter(v -> v.startsWith("jdbc:")).findFirst().orElse(null);
        }
        if (url != null) {
            Matcher m = JDBC_NETWORK_URL.matcher(url);
            Matcher local = JDBC_LOCAL_URL.matcher(url);
            if (m.find()) {
                dbSystem = normalizeDbSystem(m.group(1));
                dbHost = m.group(2);
                dbName = m.group(3);
            } else if (local.find()) {
                dbSystem = normalizeDbSystem(local.group(1));
                dbName = local.group(2);
            }
        }
        String redisHost = null;
        for (String key : List.of("spring.data.redis.host", "spring.redis.host", "redis.host", "redis.hostname", "cache.redis.host")) {
            if (props.get(key) != null && !props.get(key).contains("${")) {
                redisHost = props.get(key);
                break;
            }
        }
        return new Module(name, rel, dir, sourceRoots, appName, dbSystem, dbHost, dbName, redisHost, props,
            configFiles(dir.resolve("src/main/resources"), props), launches);
    }

    // jdbc:postgresql://orders-db:5432/orders?ssl=true -> (postgresql, orders-db, orders)
    private static final Pattern JDBC_NETWORK_URL =
        Pattern.compile("^jdbc:([a-z0-9]+)://([^/:;?]+)(?::\\d+)?/([^?;/]+)");
    // jdbc:h2:mem:testdb -> (h2, testdb)
    private static final Pattern JDBC_LOCAL_URL = Pattern.compile("^jdbc:([a-z0-9]+):(?:mem:|file:)?([^?;:/]+)");

    private static String normalizeDbSystem(String s) {
        return switch (s) {
            case "postgresql", "postgres" -> "postgresql";
            case "sqlserver" -> "mssql";
            default -> s;
        };
    }

    /**
     * Every key/value from the module's resource config: Spring's application.* first, then
     * other *.properties / *.config / *.cfg files (plain Java apps load these themselves).
     * The first file that defines a key wins.
     */
    static Map<String, String> configProperties(Path resources) {
        Map<String, String> out = springProperties(resources);
        if (!Files.isDirectory(resources)) {
            return out;
        }
        List<Path> files;
        try (var s = Files.list(resources)) {
            // real config first; dropcopy.cfg.example-style templates last, for keys only they set
            files = s.filter(p -> p.getFileName().toString().matches("(?i).+\\.(properties|config|cfg)(\\.(example|sample|template|dist))?$"))
                .filter(p -> !p.getFileName().toString().startsWith("application"))
                .sorted(java.util.Comparator.comparing((Path p) -> p.getFileName().toString().matches("(?i).+\\.(example|sample|template|dist)$"))
                    .thenComparing(Path::toString))
                .toList();
        } catch (IOException e) {
            return out;
        }
        for (Path f : files) {
            Properties p = new Properties();
            try (Reader r = Files.newBufferedReader(f)) {
                p.load(r);
                p.forEach((k, v) -> out.putIfAbsent(k.toString().trim(), v.toString().trim()));
            } catch (IOException | IllegalArgumentException ignored) {
                // not a properties file after all
            }
        }
        return out;
    }

    /** For each config key, the resource files that define it (same order as configProperties). */
    static Map<String, List<String>> configFiles(Path resources, Map<String, String> props) {
        Map<String, List<String>> out = new java.util.LinkedHashMap<>();
        if (!Files.isDirectory(resources)) {
            return out;
        }
        List<Path> files;
        try (var s = Files.list(resources)) {
            files = s.filter(p -> p.getFileName().toString().matches("(?i).+\\.(properties|config|cfg|ya?ml)$"))
                .sorted(java.util.Comparator.comparing((Path p) -> !p.getFileName().toString().startsWith("application"))
                    .thenComparing(Path::toString))
                .toList();
        } catch (IOException e) {
            return out;
        }
        for (Path f : files) {
            String text;
            try {
                text = Files.readString(f);
            } catch (IOException e) {
                continue;
            }
            for (String key : props.keySet()) {
                String leaf = key.substring(key.lastIndexOf('.') + 1);
                if (text.contains(key) || f.getFileName().toString().matches("(?i).+\\.ya?ml$") && text.contains(leaf + ":")) {
                    out.computeIfAbsent(key, k -> new ArrayList<>()).add(f.getFileName().toString());
                }
            }
        }
        return out;
    }

    /** Flattened application.properties / application.yml (main profile only). */
    static Map<String, String> springProperties(Path resources) {
        Map<String, String> out = new java.util.LinkedHashMap<>();
        Path props = resources.resolve("application.properties");
        if (Files.exists(props)) {
            Properties p = new Properties();
            try (Reader r = Files.newBufferedReader(props)) {
                p.load(r);
                p.forEach((k, v) -> out.put(k.toString(), v.toString()));
            } catch (IOException ignored) {
                // unreadable config is not fatal
            }
        }
        for (String f : List.of("application.yml", "application.yaml")) {
            Path y = resources.resolve(f);
            if (!Files.exists(y)) {
                continue;
            }
            try (InputStream in = Files.newInputStream(y)) {
                // first document only; later documents are usually profile overrides
                Object doc = new Yaml(new SafeConstructor(new LoaderOptions())).loadAll(in).iterator().next();
                flatten("", doc, out);
            } catch (Exception ignored) {
                // unreadable config is not fatal
            }
        }
        return out;
    }

    private static void flatten(String prefix, Object v, Map<String, String> out) {
        if (v instanceof Map<?, ?> m) {
            m.forEach((k, val) -> flatten(prefix.isEmpty() ? k.toString() : prefix + "." + k, val, out));
        } else if (v != null) {
            out.putIfAbsent(prefix, v.toString());
        }
    }

    private static String artifactId(Path pom) {
        if (!Files.exists(pom)) {
            return null;
        }
        try {
            var factory = DocumentBuilderFactory.newInstance();
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setExpandEntityReferences(false);
            var doc = factory.newDocumentBuilder().parse(pom.toFile());
            for (Node n = doc.getDocumentElement().getFirstChild(); n != null; n = n.getNextSibling()) {
                if (n instanceof Element e && e.getTagName().equals("artifactId")) {
                    return e.getTextContent().trim();
                }
            }
        } catch (Exception ignored) {
            // fall back to directory name
        }
        return null;
    }
}
