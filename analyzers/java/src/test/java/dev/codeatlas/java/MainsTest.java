package dev.codeatlas.java;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The java launcher's rules for which main it will run (JLS 12.1.4). */
class MainsTest {

    @Test
    void arrayFormWinsOverNoArgAndPrivateIsRejected() {
        TypeDeclaration<?> td = type("""
            class App {
                public static void main() {}
                static void main(String[] args) {}
                private static void main(String... args) {}
            }
            """);
        assertTrue(Mains.isMain(td.getMethodsByName("main").get(1)), "package-private String[] main");
        assertFalse(Mains.isMain(td.getMethodsByName("main").get(0)), "no-arg loses when String[] exists");
        assertFalse(Mains.isMain(td.getMethodsByName("main").get(2)), "private, and it is varargs");
        assertEquals("main", Mains.find(td, t -> null).getNameAsString());
        assertEquals(1, Mains.find(td, t -> null).getParameters().size());
    }

    @Test
    void instanceMainNeedsAClassTheLauncherCanConstruct() {
        TypeDeclaration<?> ok = type("class App { void main(String[] args) {} }");
        assertTrue(Mains.isMain(ok.getMethodsByName("main").get(0)));

        TypeDeclaration<?> hidden = type("class App { private App() {} void main() {} }");
        assertFalse(Mains.isMain(hidden.getMethodsByName("main").get(0)), "no usable constructor");

        TypeDeclaration<?> inner = type("""
            class Outer {
                class Inner { void main() {} }
            }
            """);
        TypeDeclaration<?> innerType = inner.getMembers().stream()
            .filter(m -> m instanceof TypeDeclaration<?>).map(m -> (TypeDeclaration<?>) m).findFirst().orElseThrow();
        assertFalse(Mains.isMain(innerType.getMethodsByName("main").get(0)), "a non-static inner class");

        TypeDeclaration<?> noArg = type("class App { public static void main() {} }");
        assertTrue(Mains.isMain(noArg.getMethodsByName("main").get(0)));
        assertEquals(0, Mains.find(noArg, t -> null).getParameters().size());
    }

    @Test
    void inheritedMainIsVisibleWhenTheBuildNamesTheSubclass() {
        TypeDeclaration<?> base = type("package base; public class Base { public static void main(String[] args) {} }");
        TypeDeclaration<?> hidden = type("package base; public class Hidden { static void main(String[] args) {} }");
        TypeDeclaration<?> app = type("package app; public class App extends base.Base {}");
        TypeDeclaration<?> other = type("package app; public class Other extends base.Hidden {}");
        Map<String, TypeDeclaration<?>> types = Map.of("base.Base", base, "base.Hidden", hidden);

        MethodDeclaration found = Mains.find(app, t -> types.get(written(t)));
        assertEquals("base.Base", found.findAncestor(TypeDeclaration.class).flatMap(td -> ((TypeDeclaration<?>) td).getFullyQualifiedName()).orElseThrow());

        assertNull(Mains.find(other, t -> types.get(written(t))), "a package-private main is not visible from another package");
    }

    private static String written(ClassOrInterfaceType t) {
        return t.getNameWithScope();
    }

    private static TypeDeclaration<?> type(String code) {
        CompilationUnit cu = new JavaParser().parse(code).getResult().orElseThrow();
        return cu.getType(0);
    }
}
