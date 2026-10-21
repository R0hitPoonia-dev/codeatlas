package dev.codeatlas.java;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

/**
 * codeatlas-java &lt;repo-dir&gt; [--repo NAME] [--commit SHA] [--branch NAME] [--out FILE]
 *
 * Writes a CodeAtlas IR document for the Java code in repo-dir. Commit and branch
 * default to the repo's git HEAD; repo defaults to the directory name.
 */
public final class Main {

    public static void main(String[] args) throws Exception {
        String dir = null, repo = null, commit = null, branch = null, out = null;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--repo" -> repo = args[++i];
                case "--commit" -> commit = args[++i];
                case "--branch" -> branch = args[++i];
                case "--out" -> out = args[++i];
                case "-h", "--help" -> {
                    usage();
                    return;
                }
                default -> {
                    if (args[i].startsWith("-") || dir != null) {
                        usage();
                        System.exit(2);
                    }
                    dir = args[i];
                }
            }
        }
        if (dir == null) {
            usage();
            System.exit(2);
        }
        Path root = Path.of(dir).toAbsolutePath().normalize();
        if (repo == null) {
            repo = root.getFileName().toString();
        }
        if (commit == null) {
            commit = git(root, "rev-parse", "HEAD");
        }
        if (commit == null) {
            System.err.println("codeatlas-java: not a git checkout; pass --commit");
            System.exit(2);
        }
        if (branch == null) {
            branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
        }

        Ir.Source source = new Ir.Source(repo, commit, branch,
            new Ir.Analyzer("java", JavaAnalyzer.VERSION), Ir.now());
        Ir.Document doc = new JavaAnalyzer(root).run(source);

        ObjectMapper json = new ObjectMapper();
        if (out == null) {
            json.writeValue(System.out, doc);
        } else {
            try (OutputStream os = Files.newOutputStream(Path.of(out))) {
                json.writeValue(os, doc);
            }
            System.err.printf("codeatlas-java: wrote %d nodes, %d edges to %s%n", doc.nodes().size(), doc.edges().size(), out);
        }
    }

    private static String git(Path dir, String... args) {
        try {
            String[] cmd = new String[args.length + 3];
            cmd[0] = "git";
            cmd[1] = "-C";
            cmd[2] = dir.toString();
            System.arraycopy(args, 0, cmd, 3, args.length);
            Process p = new ProcessBuilder(cmd).redirectErrorStream(false).start();
            String s = new String(p.getInputStream().readAllBytes()).trim();
            if (!p.waitFor(10, TimeUnit.SECONDS) || p.exitValue() != 0 || s.isEmpty() || s.equals("HEAD")) {
                return null;
            }
            return s;
        } catch (IOException | InterruptedException e) {
            return null;
        }
    }

    private static void usage() {
        System.err.println("usage: codeatlas-java <repo-dir> [--repo NAME] [--commit SHA] [--branch NAME] [--out FILE]");
    }
}
