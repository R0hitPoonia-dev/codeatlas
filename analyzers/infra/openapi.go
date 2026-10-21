package main

import (
	"net"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"codeatlas/core/ir"
)

type openAPISpec struct {
	OpenAPI     string `yaml:"openapi"`
	Swagger     string `yaml:"swagger"`
	ServiceName string `yaml:"x-service-name"`
	Info        struct {
		Title string `yaml:"title"`
	} `yaml:"info"`
	Servers []struct {
		URL string `yaml:"url"`
	} `yaml:"servers"`
	Host     string                          `yaml:"host"`
	BasePath string                          `yaml:"basePath"`
	Paths    map[string]map[string]yaml.Node `yaml:"paths"`
}

type operation struct {
	OperationID string   `yaml:"operationId"`
	Summary     string   `yaml:"summary"`
	Tags        []string `yaml:"tags"`
}

var httpMethods = map[string]bool{"get": true, "put": true, "post": true, "delete": true, "patch": true, "head": true, "options": true, "trace": true}

// openapi reads an OpenAPI 3 / Swagger 2 document (YAML or JSON) into endpoint nodes.
// Ids match the code analyzers' (endpoint:<service>:<METHOD> <route>), so a spec and the
// implementing controller merge into one node.
func (a *analyzer) openapi(rel string, data []byte) (bool, error) {
	var spec openAPISpec
	if err := yaml.Unmarshal(data, &spec); err != nil || (spec.OpenAPI == "" && spec.Swagger == "") || len(spec.Paths) == 0 {
		return false, nil
	}
	service := specService(&spec)
	svc := a.b.node("svc:"+service, ir.NodeService, service)
	svc.OTel["service.name"] = service
	addToList(svc.Attrs, "apiSpecs", rel)

	var root yaml.Node
	yaml.Unmarshal(data, &root)
	pathsNode := mappingValue(docRoot(&root), "paths")

	paths := make([]string, 0, len(spec.Paths))
	for p := range spec.Paths {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		methods := make([]string, 0)
		for m := range spec.Paths[p] {
			if httpMethods[strings.ToLower(m)] {
				methods = append(methods, m)
			}
		}
		sort.Strings(methods)
		for _, m := range methods {
			node := spec.Paths[p][m]
			var op operation
			node.Decode(&op)
			verb := strings.ToUpper(m)
			name := verb + " " + p
			e := a.b.node("endpoint:"+service+":"+name, ir.NodeEndpoint, name)
			e.Parent = svc.ID
			if key := mappingKey(mappingValue(pathsNode, p), m); key != nil {
				line := key.Line
				e.Location = &ir.Location{File: rel, StartLine: &line}
			}
			e.Attrs["method"] = verb
			e.Attrs["route"] = p
			e.Attrs["spec"] = rel
			if op.OperationID != "" {
				e.Attrs["operationId"] = op.OperationID
			}
			if op.Summary != "" {
				e.Attrs["summary"] = op.Summary
			}
			if len(op.Tags) > 0 {
				e.Attrs["tags"] = op.Tags
			}
			e.OTel["http.request.method"] = verb
			e.OTel["http.route"] = p
		}
	}
	return true, nil
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

// specService picks the service an API spec belongs to: x-service-name, then the
// server host (when it's a service name rather than an IP/localhost), then the title.
func specService(s *openAPISpec) string {
	if s.ServiceName != "" {
		return s.ServiceName
	}
	hosts := []string{s.Host}
	for _, srv := range s.Servers {
		if u, err := url.Parse(srv.URL); err == nil {
			hosts = append(hosts, u.Hostname())
		}
	}
	for _, h := range hosts {
		h, _, _ = strings.Cut(h, ":")
		if h != "" && h != "localhost" && net.ParseIP(h) == nil && !strings.Contains(h, "{") {
			return h
		}
	}
	slug := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(s.Info.Title), "-"), "-")
	if slug == "" {
		return "api"
	}
	return slug
}
