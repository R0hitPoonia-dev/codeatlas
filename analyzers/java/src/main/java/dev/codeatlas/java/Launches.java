package dev.codeatlas.java;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.jar.Manifest;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

/**
 * The runnable artifacts a build module declares: the class each one starts. `java -jar` reads
 * nothing but the jar manifest's Main-Class (sun.launcher.LauncherHelper#getMainClassFromJar),
 * and `jar --main-class` / the build plugins are what write it, so this reads the plugin
 * settings that end up there: maven-shade's ManifestResourceTransformer, the jar / assembly
 * plugins' archive manifest, spring-boot's mainClass / start-class, jib and appassembler,
 * Gradle's application / jar manifest settings, and a checked-in META-INF/MANIFEST.MF.
 * exec-maven-plugin's mainClass (how a project is run during development) counts only when
 * nothing is packaged with a main class.
 */
final class Launches {

    /**
     * One way the build starts the program.
     *
     * @param mainClass  fully qualified class name, nested classes with '.'
     * @param via        what declares it: maven-shade, maven-jar, maven-assembly, spring-boot, jib,
     *                   appassembler, exec, manifest, gradle
     * @param name       the artifact name the build gives this launch (execution finalName, program id), if any
     * @param classifier the attached artifact's classifier (shade's shadedClassifierName), if any
     * @param jar        the jar file the build writes, when it can be worked out
     * @param declaredIn build file, relative to the repo root
     */
    record Launch(String mainClass, String via, String name, String classifier, String jar, String declaredIn) {}

    private Launches() {}

    private static final Pattern PLACEHOLDER = Pattern.compile("\\$\\{([^}]+)}");
    private static final Pattern CLASS_NAME = Pattern.compile("[A-Za-z_$][\\w$]*(\\.[A-Za-z_$][\\w$]*)*");

    /** Launches the build module in `dir` declares (Maven and/or Gradle, plus a checked-in manifest). */
    static List<Launch> of(Path root, Path dir) {
        List<Launch> out = new ArrayList<>();
        Path pom = dir.resolve("pom.xml");
        if (Files.exists(pom)) {
            out.addAll(maven(root, dir));
        }
        for (String f : List.of("build.gradle", "build.gradle.kts")) {
            if (Files.exists(dir.resolve(f))) {
                out.addAll(gradle(root, dir.resolve(f)));
            }
        }
        if (out.stream().noneMatch(l -> !l.via().equals("exec"))) {
            Path mf = dir.resolve("src/main/resources/META-INF/MANIFEST.MF");
            String main = manifestMain(mf);
            if (main != null) {
                out.add(0, new Launch(main, "manifest", null, null, null, rel(root, mf)));
            }
        }
        return dedupe(out);
    }

    /** One launch per main class (the first declaration wins); exec only when nothing is packaged. */
    private static List<Launch> dedupe(List<Launch> all) {
        boolean packaged = all.stream().anyMatch(l -> !l.via().equals("exec"));
        Map<String, Launch> out = new LinkedHashMap<>();
        for (Launch l : all) {
            if (packaged && l.via().equals("exec")) {
                continue;
            }
            out.putIfAbsent(l.mainClass(), l);
        }
        return new ArrayList<>(out.values());
    }

    // ------------------------------------------------------------------ Maven

    private static List<Launch> maven(Path root, Path dir) {
        Element project = parse(dir.resolve("pom.xml"));
        if (project == null || "pom".equals(text(child(project, "packaging")))) {
            return List.of();
        }
        // poms above this one, nearest first: Maven's default parent is ../pom.xml
        List<Element> parents = new ArrayList<>();
        for (Path p = dir.getParent(); p != null && p.startsWith(root); p = p.getParent()) {
            Element e = parse(p.resolve("pom.xml"));
            if (e != null) {
                parents.add(e);
            }
        }
        Map<String, String> props = properties(project, parents);
        String file = rel(root, dir.resolve("pom.xml"));
        String finalName = resolve(props.get("project.build.finalName"), props);

        // active plugins: this pom's, then inherited ones; settings also come from pluginManagement
        Map<String, List<Element>> plugins = new LinkedHashMap<>();
        List<Element> chain = new ArrayList<>(List.of(project));
        chain.addAll(parents);
        for (Element pom : chain) {
            for (Element p : children(child(child(pom, "build"), "plugins"), "plugin")) {
                plugins.computeIfAbsent(text(child(p, "artifactId")), k -> new ArrayList<>()).add(p);
            }
        }
        for (Element pom : chain) {
            for (Element p : children(child(child(child(pom, "build"), "pluginManagement"), "plugins"), "plugin")) {
                List<Element> active = plugins.get(text(child(p, "artifactId")));
                if (active != null) {
                    active.add(p);
                }
            }
        }

        List<Launch> out = new ArrayList<>();
        plugins.forEach((artifact, decls) -> {
            if (artifact == null) {
                return;
            }
            // each execution, then the plugin-level configuration (own first, then inherited)
            List<Element> executions = decls.stream()
                .flatMap(p -> children(child(p, "executions"), "execution").stream()).toList();
            List<Element> configs = decls.stream().map(p -> child(p, "configuration")).filter(c -> c != null).toList();
            List<List<Element>> runs = new ArrayList<>();
            if (executions.isEmpty()) {
                runs.add(configs);
            }
            for (Element ex : executions) {
                List<Element> layered = new ArrayList<>();
                if (child(ex, "configuration") != null) {
                    layered.add(child(ex, "configuration"));
                }
                layered.addAll(configs);
                runs.add(layered);
            }
            for (List<Element> layered : runs) {
                Launch l = switch (artifact) {
                    case "maven-shade-plugin" -> shade(layered, props, finalName, file);
                    case "maven-jar-plugin" -> archive(dir, layered, props, "maven-jar", finalName, first(layered, props, "classifier"), file);
                    case "maven-assembly-plugin" -> assembly(dir, layered, props, finalName, file);
                    case "spring-boot-maven-plugin" -> {
                        String main = first(layered, props, "mainClass");
                        yield launch(main != null ? main : resolve(props.get("start-class"), props),
                            "spring-boot", null, null, finalName == null ? null : finalName + ".jar", file);
                    }
                    case "jib-maven-plugin" -> launch(firstAt(layered, props, "container", "mainClass"), "jib", null, null, null, file);
                    case "exec-maven-plugin" -> launch(first(layered, props, "mainClass"), "exec", null, null, null, file);
                    default -> null;
                };
                if (l != null) {
                    out.add(l);
                }
                if (artifact.equals("appassembler-maven-plugin")) {
                    for (Element c : layered) {
                        for (Element prog : children(child(c, "programs"), "program")) {
                            Launch a = launch(resolve(text(child(prog, "mainClass")), props), "appassembler",
                                resolve(text(child(prog, "id")), props), null, null, file);
                            if (a != null) {
                                out.add(a);
                            }
                        }
                    }
                }
            }
        });
        // antrun <move> renames the jar after shade (producer-${version}.jar); match on the file name
        List<Element> moves = new ArrayList<>();
        for (Element p : plugins.getOrDefault("maven-antrun-plugin", List.of())) {
            collect(child(p, "configuration"), "move", moves);
            for (Element ex : children(child(p, "executions"), "execution")) {
                collect(child(ex, "configuration"), "move", moves);
            }
        }
        if (!moves.isEmpty()) {
            List<Launch> renamed = new ArrayList<>();
            for (Launch l : out) {
                renamed.add(renamedJar(l, moves, props));
            }
            return renamed;
        }
        return out;
    }

    /** Ant's {@code <move file tofile>} names its inputs as attributes, sometimes as elements. */
    private static Launch renamedJar(Launch l, List<Element> moves, Map<String, String> props) {
        if (l.jar() == null) {
            return l;
        }
        for (Element move : moves) {
            String from = baseName(resolvePartial(attrOrChild(move, "file"), props));
            String to = baseName(resolvePartial(attrOrChild(move, "tofile"), props));
            if (l.jar().equals(from) && to != null && to.endsWith(".jar")) {
                return new Launch(l.mainClass(), l.via(), l.name(), l.classifier(), to, l.declaredIn());
            }
        }
        return l;
    }

    /** Like {@link #resolve} but keeps a value that still contains an unknown ${…}. */
    private static String resolvePartial(String s, Map<String, String> props) {
        if (s == null || s.isBlank()) {
            return null;
        }
        String out = s.trim();
        for (int pass = 0; pass < 5 && out.contains("${"); pass++) {
            Matcher m = PLACEHOLDER.matcher(out);
            StringBuilder sb = new StringBuilder();
            while (m.find()) {
                String v = props.get(m.group(1));
                m.appendReplacement(sb, Matcher.quoteReplacement(v != null ? v : m.group()));
            }
            m.appendTail(sb);
            if (sb.toString().equals(out)) {
                break;
            }
            out = sb.toString();
        }
        return out;
    }

    private static String baseName(String path) {
        if (path == null) {
            return null;
        }
        int slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        String base = (slash >= 0 ? path.substring(slash + 1) : path).trim();
        return base.isEmpty() || base.contains("${") ? null : base;
    }

    private static String attrOrChild(Element e, String name) {
        if (e.hasAttribute(name) && !e.getAttribute(name).isBlank()) {
            return e.getAttribute(name).trim();
        }
        return text(child(e, name));
    }

    private static void collect(Element e, String tag, List<Element> out) {
        if (e == null) {
            return;
        }
        if (tag.equals(e.getTagName())) {
            out.add(e);
        }
        for (Element c : children(e, null)) {
            collect(c, tag, out);
        }
    }

    private static Launch shade(List<Element> layered, Map<String, String> props, String finalName, String file) {
        String main = null;
        for (Element c : layered) {
            for (Element t : children(child(c, "transformers"), "transformer")) {
                if (!t.getAttribute("implementation").endsWith("ManifestResourceTransformer")) {
                    continue;
                }
                main = resolve(text(child(t, "mainClass")), props);
                if (main == null) {
                    main = resolve(text(child(child(t, "manifestEntries"), "Main-Class")), props);
                }
                if (main != null) {
                    break;
                }
            }
            if (main != null) {
                break;
            }
        }
        if (main == null) {
            return null;
        }
        String name = first(layered, props, "finalName");
        String classifier = null;
        if ("true".equals(first(layered, props, "shadedArtifactAttached"))) {
            classifier = first(layered, props, "shadedClassifierName");
            if (classifier == null) {
                classifier = "shaded";
            }
        }
        String jar = name != null ? name + ".jar"
            : finalName == null ? null : classifier != null ? finalName + "-" + classifier + ".jar" : finalName + ".jar";
        return launch(main, "maven-shade", name, classifier, jar, file);
    }

    /** The archive manifest's main class (maven-jar / maven-assembly / maven-war `<archive>`). */
    private static Launch archive(Path dir, List<Element> layered, Map<String, String> props, String via, String finalName,
                                  String classifier, String file) {
        String main = firstAt(layered, props, "archive", "manifest", "mainClass");
        if (main == null) {
            main = firstAt(layered, props, "archive", "manifestEntries", "Main-Class");
        }
        if (main == null) {
            String mf = firstAt(layered, props, "archive", "manifestFile");
            if (mf != null) {
                main = manifestMain(dir.resolve(mf.replace("${project.basedir}/", "").replace("${basedir}/", "")));
            }
        }
        String jar = finalName == null ? null : finalName + (classifier != null ? "-" + classifier : "") + ".jar";
        return launch(main, via, null, classifier, jar, file);
    }

    private static Launch assembly(Path dir, List<Element> layered, Map<String, String> props, String finalName, String file) {
        String name = first(layered, props, "finalName");
        String base = name != null ? name : finalName;
        String id = null;
        for (Element c : layered) {
            Element ref = child(child(c, "descriptorRefs"), "descriptorRef");
            if (ref != null) {
                id = resolve(text(ref), props);
                break;
            }
        }
        boolean append = !"false".equals(first(layered, props, "appendAssemblyId"));
        Launch a = archive(dir, layered, props, "maven-assembly", null, null, file);
        if (a == null) {
            return null;
        }
        String jar = base == null ? null : base + (append && id != null ? "-" + id : "") + ".jar";
        return new Launch(a.mainClass(), a.via(), name, append ? id : null, jar, file);
    }

    /**
     * Properties a pom can refer to: its parents' and its own {@code <properties>} (own wins),
     * project.artifactId / version / groupId, and project.build.finalName.
     */
    private static Map<String, String> properties(Element project, List<Element> parents) {
        Map<String, String> props = new HashMap<>();
        for (int i = parents.size() - 1; i >= 0; i--) {
            for (Element p : children(child(parents.get(i), "properties"), null)) {
                props.put(p.getTagName(), p.getTextContent().trim());
            }
        }
        for (Element p : children(child(project, "properties"), null)) {
            props.put(p.getTagName(), p.getTextContent().trim());
        }
        Element parent = child(project, "parent");
        String artifactId = text(child(project, "artifactId"));
        String version = text(child(project, "version"));
        if (version == null) {
            version = text(child(parent, "version"));
        }
        String groupId = text(child(project, "groupId"));
        if (groupId == null) {
            groupId = text(child(parent, "groupId"));
        }
        for (String prefix : List.of("project.", "pom.", "")) {
            if (artifactId != null) {
                props.putIfAbsent(prefix + "artifactId", artifactId);
            }
            if (version != null) {
                props.putIfAbsent(prefix + "version", version);
            }
            if (groupId != null) {
                props.putIfAbsent(prefix + "groupId", groupId);
            }
        }
        String finalName = text(child(child(project, "build"), "finalName"));
        if (finalName == null && artifactId != null) {
            finalName = version != null ? artifactId + "-" + version : artifactId;
        }
        if (finalName != null) {
            props.put("project.build.finalName", finalName);
        }
        return props;
    }

    /** `s` with ${…} references filled in from props; null when a reference stays unresolved. */
    static String resolve(String s, Map<String, String> props) {
        if (s == null || s.isBlank()) {
            return null;
        }
        String out = s.trim();
        for (int pass = 0; pass < 5 && out.contains("${"); pass++) {
            Matcher m = PLACEHOLDER.matcher(out);
            StringBuilder sb = new StringBuilder();
            while (m.find()) {
                String v = props.get(m.group(1));
                m.appendReplacement(sb, Matcher.quoteReplacement(v != null ? v : m.group()));
            }
            m.appendTail(sb);
            if (sb.toString().equals(out)) {
                break;
            }
            out = sb.toString();
        }
        return out.contains("${") ? null : out;
    }

    /** The first layer that sets `tag` (directly under the configuration). */
    private static String first(List<Element> layered, Map<String, String> props, String tag) {
        return firstAt(layered, props, tag);
    }

    private static String firstAt(List<Element> layered, Map<String, String> props, String... path) {
        for (Element c : layered) {
            Element e = c;
            for (String p : path) {
                e = child(e, p);
            }
            String v = resolve(text(e), props);
            if (v != null) {
                return v;
            }
        }
        return null;
    }

    // ----------------------------------------------------------------- Gradle

    // mainClass = "a.B" / mainClass.set("a.B") (application, springBoot, bootJar, javaexec)
    private static final Pattern GRADLE_MAIN_CLASS =
        Pattern.compile("\\bmainClass(?:Name)?\\s*(?:=|\\.set\\s*\\()\\s*['\"]([\\w.$]+)['\"]");
    // attributes 'Main-Class': 'a.B' / attributes("Main-Class" to "a.B") / attributes["Main-Class"] = "a.B"
    private static final Pattern GRADLE_MANIFEST =
        Pattern.compile("['\"]Main-Class['\"]\\s*(?::|to|,|]\\s*=)\\s*['\"]([\\w.$]+)['\"]");

    private static List<Launch> gradle(Path root, Path file) {
        String text;
        try {
            text = Files.readString(file);
        } catch (IOException e) {
            return List.of();
        }
        text = text.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//.*$", "");
        List<Launch> out = new ArrayList<>();
        for (Pattern p : List.of(GRADLE_MANIFEST, GRADLE_MAIN_CLASS)) {
            Matcher m = p.matcher(text);
            while (m.find()) {
                Launch l = launch(m.group(1), "gradle", null, null, null, rel(root, file));
                if (l != null) {
                    out.add(l);
                }
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ helpers

    private static String manifestMain(Path mf) {
        if (!Files.isRegularFile(mf)) {
            return null;
        }
        try (InputStream in = Files.newInputStream(mf)) {
            String v = new Manifest(in).getMainAttributes().getValue("Main-Class");
            return v == null || v.isBlank() ? null : v.trim();
        } catch (IOException e) {
            return null;
        }
    }

    private static Launch launch(String main, String via, String name, String classifier, String jar, String file) {
        if (main == null) {
            return null;
        }
        // the manifest names the binary class (Outer$Inner); source declarations use Outer.Inner
        String fqn = main.trim().replace('$', '.').replace('/', '.');
        return CLASS_NAME.matcher(fqn).matches() ? new Launch(fqn, via, name, classifier, jar, file) : null;
    }

    private static String rel(Path root, Path p) {
        return root.relativize(p).toString().replace('\\', '/');
    }

    private static Element parse(Path pom) {
        if (!Files.isRegularFile(pom)) {
            return null;
        }
        try {
            var factory = DocumentBuilderFactory.newInstance();
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setExpandEntityReferences(false);
            return factory.newDocumentBuilder().parse(pom.toFile()).getDocumentElement();
        } catch (Exception e) {
            return null;
        }
    }

    private static Element child(Element parent, String tag) {
        if (parent == null) {
            return null;
        }
        for (Node n = parent.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element e && e.getTagName().equals(tag)) {
                return e;
            }
        }
        return null;
    }

    /** Child elements named `tag` (every child element when tag is null). */
    private static List<Element> children(Element parent, String tag) {
        List<Element> out = new ArrayList<>();
        if (parent == null) {
            return out;
        }
        for (Node n = parent.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element e && (tag == null || e.getTagName().equals(tag))) {
                out.add(e);
            }
        }
        return out;
    }

    private static String text(Element e) {
        if (e == null) {
            return null;
        }
        String t = e.getTextContent().trim();
        return t.isEmpty() ? null : t;
    }
}
