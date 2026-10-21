package main

import (
	"fmt"
	"path"
	"regexp"
	"slices"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"codeatlas/core/ir"
)

var composeFileRe = regexp.MustCompile(`^(docker-)?compose(\.[\w-]+)?\.ya?ml$`)

type composeService struct {
	Image       string    `yaml:"image"`
	Build       yaml.Node `yaml:"build"`
	Command     yaml.Node `yaml:"command"`
	Entrypoint  yaml.Node `yaml:"entrypoint"`
	Ports       []any     `yaml:"ports"`
	Environment yaml.Node `yaml:"environment"`
	DependsOn   yaml.Node `yaml:"depends_on"`
	Links       []string  `yaml:"links"`
}

// imageRoles classifies well-known infrastructure images.
var imageRoles = []struct {
	re   *regexp.Regexp
	role string
}{
	{regexp.MustCompile(`(^|/)(postgres|postgis|mysql|mariadb|mongo|cockroach|mssql|oracle|cassandra|clickhouse|timescale)`), "database"},
	{regexp.MustCompile(`(^|/)(redis|valkey|memcached|keydb)`), "cache"},
	{regexp.MustCompile(`(^|/)(kafka|cp-kafka|redpanda|rabbitmq|nats|pulsar|activemq|zookeeper)`), "broker"},
	{regexp.MustCompile(`(^|/)(nginx|traefik|envoy|haproxy|caddy)`), "proxy"},
	{regexp.MustCompile(`(^|/)(elasticsearch|opensearch|meilisearch)`), "search"},
	{regexp.MustCompile(`(^|/)(jaeger|otel|opentelemetry|prometheus|grafana|tempo|loki)`), "observability"},
}

func imageRole(image string) string {
	for _, r := range imageRoles {
		if r.re.MatchString(image) {
			return r.role
		}
	}
	return ""
}

// Environment variables whose values name the service for telemetry; safe to read.
var serviceNameEnv = []string{"OTEL_SERVICE_NAME", "SPRING_APPLICATION_NAME", "SERVICE_NAME"}

func (a *analyzer) compose(rel string, data []byte) error {
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return fmt.Errorf("%s: %w", rel, err)
	}
	services := mappingValue(docRoot(&root), "services")
	if services == nil || services.Kind != yaml.MappingNode {
		return nil
	}
	dir := path.Dir(rel)
	type entry struct {
		name string
		svc  composeService
		line int
	}
	var entries []entry
	for i := 0; i+1 < len(services.Content); i += 2 {
		var svc composeService
		if err := services.Content[i+1].Decode(&svc); err != nil {
			return fmt.Errorf("%s: service %s: %w", rel, services.Content[i].Value, err)
		}
		entries = append(entries, entry{services.Content[i].Value, svc, services.Content[i].Line})
	}
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.name
	}

	for _, e := range entries {
		n := a.b.node("ctr:"+e.name, ir.NodeContainer, e.name)
		line := e.line
		n.Location = &ir.Location{File: rel, StartLine: &line}
		n.Attrs["source"] = "compose"
		if e.svc.Image != "" {
			n.Attrs["image"] = e.svc.Image
			if role := imageRole(e.svc.Image); role != "" {
				n.Attrs["role"] = role
			}
		}
		command, entrypoint := nodeText(&e.svc.Command), nodeText(&e.svc.Entrypoint)
		launch := []string{command, entrypoint}
		if ctx := buildContext(&e.svc.Build); ctx != "" {
			n.Attrs["buildContext"] = cleanRel(path.Join(dir, ctx))
			df := cleanRel(path.Join(dir, ctx, dockerfileName(&e.svc.Build)))
			if d, ok := a.dockerfileLaunch(df); ok {
				n.Attrs["dockerfile"] = df
				// the service's own entrypoint / command replace the image's (and an entrypoint drops CMD)
				if entrypoint == "" {
					launch = append(launch, d.entrypoint)
					if command == "" {
						launch = append(launch, d.cmd)
					}
				}
				launch = append(launch, d.jars...)
			}
		}
		noteLaunch(n.Attrs, launch...)
		if len(e.svc.Ports) > 0 {
			ports := make([]string, 0, len(e.svc.Ports))
			for _, p := range e.svc.Ports {
				ports = append(ports, fmt.Sprint(p))
			}
			n.Attrs["ports"] = ports
		}

		env := environment(&e.svc.Environment)
		for _, k := range serviceNameEnv {
			if v := env[k]; v != "" {
				n.Attrs["serviceName"] = v
				n.OTel["service.name"] = v
				break
			}
		}
		// Only keys are recorded: values often hold credentials.
		if len(env) > 0 {
			keys := make([]string, 0, len(env))
			for k := range env {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			n.Attrs["envKeys"] = keys
		}

		for _, dep := range dependsOn(&e.svc.DependsOn) {
			a.b.edge(n.ID, "ctr:"+dep, ir.EdgeConnectsTo).Attrs["via"] = "depends_on"
		}
		for _, l := range e.svc.Links {
			a.b.edge(n.ID, "ctr:"+strings.SplitN(l, ":", 2)[0], ir.EdgeConnectsTo).Attrs["via"] = "links"
		}
		// Hostnames of other services mentioned in env values (URLs, broker lists).
		for k, v := range env {
			for _, other := range names {
				if other != e.name && mentionsHost(v, other) {
					addToList(a.b.edge(n.ID, "ctr:"+other, ir.EdgeConnectsTo).Attrs, "env", k)
				}
			}
		}
	}
	return nil
}

func mentionsHost(value, host string) bool {
	re := regexp.MustCompile(`(^|[/@,=\s])` + regexp.QuoteMeta(host) + `($|[:/,\s?])`)
	return re.MatchString(value)
}

var (
	jarFileRe = regexp.MustCompile(`(?i)(?:^|[/\\\s'"=:])([\w.*?-]+\.jar)\b`)
	classRe   = regexp.MustCompile(`^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)+$`)
)

// javaOptsWithValue are java launcher options whose next argument is their value, not the main class.
var javaOptsWithValue = map[string]bool{
	"-cp": true, "-classpath": true, "--class-path": true, "-jar": true, "-p": true, "--module-path": true,
	"--add-modules": true, "--add-opens": true, "--add-exports": true, "--add-reads": true,
	"-javaagent": true, "--upgrade-module-path": true,
}

// noteLaunch records the jar files and main classes a container command names
// (attrs.jars, may hold globs like producer-*.jar; attrs.mainClasses), so a directory that
// builds several programs can be linked to the one this container actually starts. A main
// class is a plain dotted argument: option values (-Dkey=a.b, -cp lib.jar) are skipped, so
// nothing an option carries is recorded.
func noteLaunch(attrs map[string]any, texts ...string) {
	var jars, classes []string
	seenJ, seenC := map[string]bool{}, map[string]bool{}
	for _, text := range texts {
		for _, m := range jarFileRe.FindAllStringSubmatch(text, -1) {
			base := path.Base(m[1])
			if seenJ[base] {
				continue
			}
			seenJ[base] = true
			jars = append(jars, base)
		}
		args := strings.Fields(strings.NewReplacer(`"`, " ", "'", " ", ",", " ", "[", " ", "]", " ").Replace(text))
		for i := 0; i < len(args); i++ {
			arg := args[i]
			if strings.HasPrefix(arg, "-") {
				if javaOptsWithValue[arg] {
					i++
				}
				continue
			}
			if arg == "-m" || arg == "--module" {
				continue
			}
			if strings.ContainsAny(arg, "=/:") || strings.HasSuffix(strings.ToLower(arg), ".jar") || !classRe.MatchString(arg) || seenC[arg] {
				continue
			}
			seenC[arg] = true
			classes = append(classes, arg)
		}
	}
	if len(jars) > 0 {
		attrs["jars"] = jars
	}
	if len(classes) > 0 {
		attrs["mainClasses"] = classes
	}
}

func nodeText(n *yaml.Node) string {
	if n == nil {
		return ""
	}
	switch n.Kind {
	case yaml.ScalarNode:
		return n.Value
	case yaml.AliasNode:
		return nodeText(n.Alias)
	case yaml.SequenceNode:
		parts := make([]string, 0, len(n.Content))
		for _, c := range n.Content {
			if c.Kind == yaml.ScalarNode && c.Value != "" {
				parts = append(parts, c.Value)
			}
		}
		return strings.Join(parts, " ")
	default:
		return ""
	}
}

// dockerfileName is build.dockerfile (relative to the context), else Dockerfile.
func dockerfileName(n *yaml.Node) string {
	if n.Kind == yaml.MappingNode {
		if d := mappingValue(n, "dockerfile"); d != nil && d.Value != "" {
			return d.Value
		}
	}
	return "Dockerfile"
}

func buildContext(n *yaml.Node) string {
	switch n.Kind {
	case yaml.ScalarNode:
		return n.Value
	case yaml.MappingNode:
		if c := mappingValue(n, "context"); c != nil {
			return c.Value
		}
		return "."
	}
	return ""
}

func environment(n *yaml.Node) map[string]string {
	env := map[string]string{}
	switch n.Kind {
	case yaml.MappingNode:
		for i := 0; i+1 < len(n.Content); i += 2 {
			env[n.Content[i].Value] = n.Content[i+1].Value
		}
	case yaml.SequenceNode:
		for _, item := range n.Content {
			k, v, _ := strings.Cut(item.Value, "=")
			env[k] = v
		}
	}
	return env
}

func dependsOn(n *yaml.Node) []string {
	var out []string
	switch n.Kind {
	case yaml.SequenceNode:
		for _, item := range n.Content {
			out = append(out, item.Value)
		}
	case yaml.MappingNode:
		for i := 0; i < len(n.Content); i += 2 {
			out = append(out, n.Content[i].Value)
		}
	}
	slices.Sort(out)
	return out
}

// docRoot unwraps a yaml DocumentNode.
func docRoot(n *yaml.Node) *yaml.Node {
	if n.Kind == yaml.DocumentNode && len(n.Content) > 0 {
		return n.Content[0]
	}
	return n
}

// mappingKey returns the key node (for its line number) of key in mapping n.
func mappingKey(n *yaml.Node, key string) *yaml.Node {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i]
		}
	}
	return nil
}

func mappingValue(n *yaml.Node, key string) *yaml.Node {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1]
		}
	}
	return nil
}

func cleanRel(p string) string {
	p = path.Clean(p)
	if p == "." {
		return "."
	}
	return strings.TrimPrefix(p, "./")
}
