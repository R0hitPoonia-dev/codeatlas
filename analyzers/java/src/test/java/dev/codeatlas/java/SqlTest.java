package dev.codeatlas.java;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class SqlTest {

    @Test
    void insertWithColumnsAndConflictClause() {
        Sql.Statement s = Sql.read("INSERT INTO trade_book (trade_id, account_id) VALUES (?, ?) ON CONFLICT (trade_id) DO NOTHING");
        assertEquals("INSERT", s.verb());
        assertEquals(Set.of("trade_book"), s.writes());
        assertEquals(Set.of(), s.reads());
        assertEquals(Map.of("trade_book", List.of("trade_id", "account_id")), s.columns());
    }

    @Test
    void selectWithJoinAndAliases() {
        Sql.Statement s = Sql.read("select o.id, c.email as customer_email from orders o join customers c on c.id = o.customer_id where o.note <> 'FROM x'");
        assertEquals(Set.of("orders", "customers"), s.reads());
        assertEquals(List.of("id", "customer_email"), s.columns().get("orders"));
    }

    @Test
    void writesThatAlsoRead() {
        Sql.Statement s = Sql.read("INSERT INTO archive SELECT * FROM events WHERE ts < now()");
        assertEquals(Set.of("archive"), s.writes());
        assertEquals(Set.of("events"), s.reads());
        assertEquals(Set.of("orders"), Sql.read("UPDATE orders SET status = 'PAID' FROM payments p WHERE p.order_id = orders.id").writes());
        assertEquals(Set.of("payments"), Sql.read("UPDATE orders SET status = 'PAID' FROM payments p WHERE p.order_id = orders.id").reads());
        assertEquals(Set.of("sessions"), Sql.read("DELETE FROM sessions WHERE expires_at < now()").writes());
        assertEquals(Set.of(), Sql.read("DELETE FROM sessions WHERE expires_at < now()").reads());
        assertEquals(Set.of("trade_book"), Sql.read("TRUNCATE TABLE trade_book").writes());
        assertEquals(Set.of("public.audit"), Sql.read("INSERT INTO \"public\".\"audit\" (x) VALUES (1)").writes());
    }

    @Test
    void unresolvedPartsAndNonSql() {
        assertEquals(Set.of("*"), Sql.read("SELECT * FROM * WHERE id = ?").reads()); // table from an unknown variable
        assertEquals(Set.of("trades"), Sql.read("SELECT * FROM *.trades").reads()); // unknown schema dropped
        assertNull(Sql.read("hello world"));
        assertNull(Sql.read("select the best option"));
    }
}
