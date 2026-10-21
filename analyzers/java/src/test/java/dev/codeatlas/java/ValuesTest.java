package dev.codeatlas.java;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.api.Test;

class ValuesTest {

    private static List<String> rep(String... texts) {
        List<Values.Value> vs = java.util.Arrays.stream(texts).map(t -> new Values.Value(t, null)).toList();
        return Values.representative(vs).stream().map(Values.Value::text).toList();
    }

    @Test
    void keepsTheMostInformativeKeyPattern() {
        // a helper's "" default and an unresolved prefix both lose to the specific pattern
        assertEquals(List.of("position:*:*"), rep("position::", "position:*:*", "*:*:*", "position:*:"));
        // unrelated patterns are all kept
        assertEquals(List.of("price:*", "symbols"), rep("price:*", "symbols"));
        assertEquals(List.of("*"), rep("*"));
    }
}
