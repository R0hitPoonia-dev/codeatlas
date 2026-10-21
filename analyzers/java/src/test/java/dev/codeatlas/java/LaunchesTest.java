package dev.codeatlas.java;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** What each build writes into a jar's Main-Class, read back out of the build files. */
class LaunchesTest {

    @TempDir
    Path dir;

    @Test
    void shadeExecutionsBecomeOneLaunchEachAndAntrunRenamesTheJar() throws Exception {
        write("pom.xml", """
            <project>
              <artifactId>livepnl</artifactId>
              <version>1.2</version>
              <build><plugins>
                <plugin><artifactId>maven-shade-plugin</artifactId>
                  <executions>
                    <execution><id>producer-fat-jar</id><configuration>
                      <shadedArtifactAttached>true</shadedArtifactAttached>
                      <shadedClassifierName>producer</shadedClassifierName>
                      <transformers>
                        <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
                          <mainClass>producer.Main</mainClass>
                        </transformer>
                      </transformers>
                    </configuration></execution>
                    <execution><id>consumer-fat-jar</id><configuration>
                      <shadedArtifactAttached>true</shadedArtifactAttached>
                      <shadedClassifierName>consumer</shadedClassifierName>
                      <transformers>
                        <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
                          <mainClass>${consumer.main}</mainClass>
                        </transformer>
                      </transformers>
                    </configuration></execution>
                  </executions>
                </plugin>
                <plugin><artifactId>maven-antrun-plugin</artifactId>
                  <executions><execution><configuration><target>
                    <move file="${project.build.directory}/${project.build.finalName}-producer.jar"
                          tofile="${project.build.directory}/producer-${project.version}.jar"/>
                    <move file="${project.build.directory}/${project.build.finalName}-consumer.jar"
                          tofile="${project.build.directory}/consumer-${project.version}.jar"/>
                  </target></configuration></execution></executions>
                </plugin>
                <plugin><artifactId>exec-maven-plugin</artifactId>
                  <configuration><mainClass>tools.NotPacked</mainClass></configuration>
                </plugin>
              </plugins></build>
              <properties><consumer.main>consumer.Main</consumer.main></properties>
            </project>
            """);
        List<Launches.Launch> launches = Launches.of(dir, dir);
        assertEquals(2, launches.size(), "exec-maven is how you run it in dev, not a jar");
        Launches.Launch producer = launches.get(0);
        assertEquals("producer.Main", producer.mainClass());
        assertEquals("maven-shade", producer.via());
        assertEquals("producer", producer.classifier());
        assertEquals("producer-1.2.jar", producer.jar());
        Launches.Launch consumer = launches.get(1);
        assertEquals("consumer.Main", consumer.mainClass());
        assertEquals("consumer-1.2.jar", consumer.jar());
    }

    @Test
    void childInheritsTheParentsShadeMainClass() throws Exception {
        write("pom.xml", """
            <project><artifactId>parent</artifactId><packaging>pom</packaging>
              <build><pluginManagement><plugins>
                <plugin><artifactId>maven-shade-plugin</artifactId>
                  <configuration><transformers>
                    <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
                      <mainClass>${app.main}</mainClass>
                    </transformer>
                  </transformers></configuration>
                </plugin>
              </plugins></pluginManagement></build>
            </project>
            """);
        write("app/pom.xml", """
            <project><artifactId>app</artifactId><version>9</version>
              <properties><app.main>demo.App</app.main></properties>
              <build><plugins><plugin><artifactId>maven-shade-plugin</artifactId></plugin></plugins></build>
            </project>
            """);
        assertTrue(Launches.of(dir, dir).isEmpty(), "an aggregator pom builds no jar");
        List<Launches.Launch> launches = Launches.of(dir, dir.resolve("app"));
        assertEquals(1, launches.size());
        assertEquals("demo.App", launches.get(0).mainClass());
        assertEquals("app-9.jar", launches.get(0).jar());
        assertEquals("pom.xml", Path.of(launches.get(0).declaredIn()).getFileName().toString());
    }

    @Test
    void jarPluginManifestAndCheckedInManifest() throws Exception {
        write("with-plugin/pom.xml", """
            <project><artifactId>demo</artifactId><version>1</version>
              <build><plugins><plugin><artifactId>maven-jar-plugin</artifactId>
                <configuration><archive><manifest><mainClass>demo.App</mainClass></manifest></archive></configuration>
              </plugin></plugins></build>
            </project>
            """);
        Launches.Launch jar = Launches.of(dir, dir.resolve("with-plugin")).get(0);
        assertEquals("maven-jar", jar.via());
        assertEquals("demo-1.jar", jar.jar());

        write("manifest-only/pom.xml", "<project><artifactId>plain</artifactId><version>1</version></project>");
        write("manifest-only/src/main/resources/META-INF/MANIFEST.MF", "Manifest-Version: 1.0\nMain-Class: plain.Main\n");
        Launches.Launch mf = Launches.of(dir, dir.resolve("manifest-only")).get(0);
        assertEquals("plain.Main", mf.mainClass());
        assertEquals("manifest", mf.via());
        assertNull(mf.jar());
    }

    @Test
    void gradleMainClassAndManifestAttribute() throws Exception {
        write("build.gradle", """
            // mainClass = "commented.Out"
            application { mainClass = "demo.App" }
            jar { manifest { attributes 'Main-Class': 'demo.App' } }
            """);
        List<Launches.Launch> launches = Launches.of(dir, dir);
        assertEquals(1, launches.size());
        assertEquals("demo.App", launches.get(0).mainClass());
        assertEquals("gradle", launches.get(0).via());
    }

    private void write(String path, String text) throws Exception {
        Path p = dir.resolve(path);
        Files.createDirectories(p.getParent());
        Files.writeString(p, text);
    }
}
