package dev.codeatlas.java;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import java.util.List;
import java.util.Set;
import java.util.function.Function;

/**
 * The methods the `java` launcher accepts as a program's main, as JDK 25 decides it
 * (JLS 12.1.4; jdk.internal.misc.MethodFinder#findMainMethod, LauncherHelper#validateMainMethod):
 * named main, returning void, taking String[] / String... or nothing, not private. It may be
 * static, or an instance method when the launcher can create the class: not abstract, not an
 * inner (non-static nested) class, with a non-private no-argument constructor. The String[]
 * form is looked for first; a main inherited from a superclass, or a default method of an
 * interface the class implements, counts.
 */
final class Mains {
    private Mains() {}

    private static final Set<String> STRING_ARRAY = Set.of("String[]", "java.lang.String[]");
    private static final Set<String> STRING = Set.of("String", "java.lang.String");

    /** main(String[]) / main(String...) when withArgs, else main(); void and not private. */
    static boolean signature(MethodDeclaration m, boolean withArgs) {
        if (!m.getNameAsString().equals("main") || !m.getType().isVoidType() || m.isPrivate()) {
            return false;
        }
        if (!withArgs) {
            return m.getParameters().isEmpty();
        }
        if (m.getParameters().size() != 1) {
            return false;
        }
        Parameter p = m.getParameter(0);
        String type = p.getType().asString().replace(" ", "");
        return p.isVarArgs() ? STRING.contains(type) : STRING_ARRAY.contains(type);
    }

    /** Whether m is a main the launcher would run when its own class is the main class. */
    static boolean isMain(MethodDeclaration m) {
        if (!signature(m, true) && !signature(m, false)) {
            return false;
        }
        TypeDeclaration<?> td = m.findAncestor(TypeDeclaration.class).map(t -> (TypeDeclaration<?>) t).orElse(null);
        if (td == null) {
            return false;
        }
        // a class with main(String[]) and main() runs the String[] one
        if (m.getParameters().isEmpty() && td.getMethodsByName("main").stream().anyMatch(o -> signature(o, true))) {
            return false;
        }
        return m.isStatic() || instantiable(td);
    }

    /**
     * The main `java <td>` would run, declared in td or inherited from an in-repo supertype
     * (`supertype` resolves an extends / implements type to its declaration, or null), else null.
     */
    static MethodDeclaration find(TypeDeclaration<?> td, Function<ClassOrInterfaceType, TypeDeclaration<?>> supertype) {
        MethodDeclaration m = search(td, td, true, supertype, 0);
        if (m == null) {
            m = search(td, td, false, supertype, 0);
        }
        if (m == null || m.isStatic()) {
            return m;
        }
        return instantiable(td) ? m : null;
    }

    private static MethodDeclaration search(TypeDeclaration<?> start, TypeDeclaration<?> td, boolean withArgs,
                                            Function<ClassOrInterfaceType, TypeDeclaration<?>> supertype, int depth) {
        if (td == null || depth > 10) {
            return null;
        }
        boolean iface = td instanceof ClassOrInterfaceDeclaration c && c.isInterface();
        for (MethodDeclaration m : td.getMethodsByName("main")) {
            // static methods of an interface are not inherited by the classes that implement it
            if (signature(m, withArgs) && !(iface && td != start && m.isStatic()) && accessible(start, td, m)) {
                return m;
            }
        }
        if (!(td instanceof ClassOrInterfaceDeclaration c)) {
            return null;
        }
        List<ClassOrInterfaceType> interfaces = iface ? c.getExtendedTypes() : c.getImplementedTypes();
        for (ClassOrInterfaceType t : interfaces) {
            MethodDeclaration m = search(start, supertype.apply(t), withArgs, supertype, depth + 1);
            if (m != null && !m.isStatic()) {
                return m;
            }
        }
        if (!iface) {
            for (ClassOrInterfaceType t : c.getExtendedTypes()) {
                MethodDeclaration m = search(start, supertype.apply(t), withArgs, supertype, depth + 1);
                if (m != null) {
                    return m;
                }
            }
        }
        return null;
    }

    /** A package-private main inherited from another package is not visible to the launcher. */
    private static boolean accessible(TypeDeclaration<?> start, TypeDeclaration<?> declaring, MethodDeclaration m) {
        return declaring == start || m.isPublic() || m.isProtected() || pkg(start).equals(pkg(declaring));
    }

    private static String pkg(TypeDeclaration<?> td) {
        return td.findCompilationUnit().flatMap(CompilationUnit::getPackageDeclaration)
            .map(p -> p.getNameAsString()).orElse("");
    }

    /** Whether the launcher can create an instance to call an instance main on. */
    static boolean instantiable(TypeDeclaration<?> td) {
        if (!isTopLevelOrStatic(td)) {
            return false;
        }
        List<ConstructorDeclaration> ctors;
        if (td instanceof ClassOrInterfaceDeclaration c) {
            if (c.isInterface() || c.isAbstract()) {
                return false;
            }
            ctors = c.getConstructors();
        } else if (td instanceof RecordDeclaration r) {
            if (r.getParameters().isEmpty()) {
                return true; // the canonical constructor takes no arguments
            }
            ctors = r.getConstructors();
            return ctors.stream().anyMatch(k -> k.getParameters().isEmpty() && !k.isPrivate());
        } else {
            return false; // enums and annotations cannot be instantiated
        }
        return ctors.isEmpty() || ctors.stream().anyMatch(k -> k.getParameters().isEmpty() && !k.isPrivate());
    }

    private static boolean isTopLevelOrStatic(TypeDeclaration<?> td) {
        if (td.isTopLevelType()) {
            return true;
        }
        // nested interfaces, enums and records are implicitly static
        boolean implicitlyStatic = !(td instanceof ClassOrInterfaceDeclaration c) || c.isInterface();
        return implicitlyStatic || td.isStatic();
    }
}
