package dev.codeatlas.java;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Just enough SQL reading to say which tables a statement reads and writes, and which
 * columns it names. Not a parser: unknown identifiers ("*", from unresolved string parts)
 * are reported as unknown tables so callers can fall back to the database.
 */
final class Sql {

    /** What one statement does. {@code columns} maps a table to the columns it names. */
    record Statement(String verb, Set<String> writes, Set<String> reads, Map<String, List<String>> columns) {}

    private static final String IDENT = "((?:[\"`\\[]?[A-Za-z_*][\\w$*]*[\"`\\]]?\\.)?[\"`\\[]?[A-Za-z_*][\\w$*]*[\"`\\]]?)";
    private static final Pattern VERB = Pattern.compile(
        "^\\s*(?:/\\*.*?\\*/\\s*)*(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|TRUNCATE|CALL|EXEC|COPY)\\b",
        Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern INSERT = Pattern.compile(
        "\\b(?:INSERT|UPSERT|REPLACE)\\s+(?:IGNORE\\s+)?INTO\\s+" + IDENT + "\\s*(?:\\(([^)]*)\\))?", Pattern.CASE_INSENSITIVE);
    private static final Pattern UPDATE = Pattern.compile("^\\s*UPDATE\\s+(?:ONLY\\s+)?" + IDENT, Pattern.CASE_INSENSITIVE);
    private static final Pattern DELETE = Pattern.compile("\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?" + IDENT, Pattern.CASE_INSENSITIVE);
    private static final Pattern MERGE = Pattern.compile("\\bMERGE\\s+INTO\\s+" + IDENT, Pattern.CASE_INSENSITIVE);
    private static final Pattern TRUNCATE = Pattern.compile("\\bTRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?" + IDENT, Pattern.CASE_INSENSITIVE);
    private static final Pattern COPY = Pattern.compile("^\\s*COPY\\s+" + IDENT + "(?:\\s*\\(([^)]*)\\))?\\s+FROM\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern FROM = Pattern.compile("\\b(?:FROM|JOIN|USING)\\s+(?:ONLY\\s+)?" + IDENT, Pattern.CASE_INSENSITIVE);
    private static final Pattern SELECT_LIST = Pattern.compile("^\\s*SELECT\\s+(?:DISTINCT\\s+)?(.*?)\\s+FROM\\s+" + IDENT,
        Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Set<String> NOT_TABLES = Set.of("select", "lateral", "unnest", "values", "dual", "generate_series");

    private Sql() {}

    /** Reads a statement, or null if the text does not look like SQL. */
    static Statement read(String sql) {
        if (sql == null) {
            return null;
        }
        Matcher v = VERB.matcher(sql);
        if (!v.find()) {
            return null;
        }
        String verb = v.group(1).toUpperCase(Locale.ROOT);
        Set<String> writes = new LinkedHashSet<>();
        Set<String> reads = new LinkedHashSet<>();
        Map<String, List<String>> columns = new LinkedHashMap<>();
        String body = stripLiterals(sql);

        Matcher m = INSERT.matcher(body);
        while (m.find()) {
            String t = table(m.group(1));
            writes.add(t);
            if (m.group(2) != null) {
                columns.put(t, columnList(m.group(2)));
            }
        }
        for (Pattern p : List.of(UPDATE, DELETE, MERGE, TRUNCATE)) {
            m = p.matcher(body);
            while (m.find()) {
                writes.add(table(m.group(1)));
            }
        }
        m = COPY.matcher(body);
        if (m.find()) {
            String t = table(m.group(1));
            writes.add(t);
            if (m.group(2) != null) {
                columns.put(t, columnList(m.group(2)));
            }
        }
        m = FROM.matcher(body);
        while (m.find()) {
            String t = table(m.group(1));
            if (!NOT_TABLES.contains(t.toLowerCase(Locale.ROOT)) && !(verb.equals("DELETE") && writes.contains(t))) {
                reads.add(t);
            }
        }
        if (verb.equals("SELECT")) {
            m = SELECT_LIST.matcher(body);
            if (m.find()) {
                List<String> cols = columnList(m.group(1));
                if (!cols.isEmpty() && !cols.contains("*")) {
                    columns.putIfAbsent(table(m.group(2)), cols);
                }
            }
        }
        // the target of UPDATE ... FROM other is written, not read
        reads.removeAll(verb.equals("SELECT") || verb.equals("WITH") ? Set.of() : writesOnly(verb, writes));
        if (writes.isEmpty() && reads.isEmpty() && !verb.equals("CALL") && !verb.equals("EXEC")) {
            return null;
        }
        return new Statement(verb, writes, reads, columns);
    }

    private static Set<String> writesOnly(String verb, Set<String> writes) {
        return verb.equals("UPDATE") || verb.equals("DELETE") ? writes : Set.of();
    }

    /** Replaces quoted string contents so 'FROM x' inside a literal is ignored. */
    private static String stripLiterals(String sql) {
        return sql.replaceAll("'(?:[^']|'')*'", "''");
    }

    private static String table(String raw) {
        String t = raw.replaceAll("[\"`\\[\\]]", "");
        int dot = t.lastIndexOf('.');
        // keep schema-qualified names, but "*" schemas (unresolved) are dropped
        if (dot > 0 && t.substring(0, dot).equals(Values.UNKNOWN)) {
            t = t.substring(dot + 1);
        }
        return t;
    }

    /** "a, b AS x, t.c" -> [a, x, c]; expressions without a plain name are skipped. */
    private static List<String> columnList(String list) {
        List<String> out = new ArrayList<>();
        int level = 0;
        StringBuilder cur = new StringBuilder();
        for (char c : (list + ",").toCharArray()) {
            if (c == '(') {
                level++;
            } else if (c == ')') {
                level--;
            }
            if (c == ',' && level == 0) {
                String col = column(cur.toString().trim());
                if (col != null) {
                    out.add(col);
                }
                cur.setLength(0);
            } else {
                cur.append(c);
            }
        }
        return out;
    }

    private static String column(String expr) {
        if (expr.equals("*")) {
            return "*";
        }
        Matcher alias = Pattern.compile("(?i)\\s+AS\\s+[\"`]?(\\w+)[\"`]?$").matcher(expr);
        if (alias.find()) {
            return alias.group(1);
        }
        Matcher plain = Pattern.compile("^(?:\\w+\\.)?[\"`]?(\\w+)[\"`]?$").matcher(expr);
        return plain.find() ? plain.group(1) : null;
    }
}
