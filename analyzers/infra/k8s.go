package main

import (
	"bytes"
	"errors"
	"io"
	"maps"
	"strings"

	"gopkg.in/yaml.v3"

	"codeatlas/core/ir"
)

type k8sMeta struct {
	Name      string            `yaml:"name"`
	Namespace string            `yaml:"namespace"`
	Labels    map[string]string `yaml:"labels"`
}

type podTemplate struct {
	Metadata k8sMeta `yaml:"metadata"`
	Spec     struct {
		Containers []struct {
			Name    string   `yaml:"name"`
			Image   string   `yaml:"image"`
			Command []string `yaml:"command"`
			Args    []string `yaml:"args"`
		} `yaml:"containers"`
	} `yaml:"spec"`
}

type k8sObject struct {
	APIVersion string  `yaml:"apiVersion"`
	Kind       string  `yaml:"kind"`
	Metadata   k8sMeta `yaml:"metadata"`
	Spec       struct {
		Replicas *int `yaml:"replicas"`
		Selector struct {
			MatchLabels map[string]string `yaml:"matchLabels"`
		} `yaml:"selector"`
		Template    podTemplate `yaml:"template"`
		JobTemplate struct {
			Spec struct {
				Template podTemplate `yaml:"template"`
			} `yaml:"spec"`
		} `yaml:"jobTemplate"`
		// Service
		ServiceSelector map[string]string `yaml:"-"`
		// Ingress
		Rules []struct {
			Host string `yaml:"host"`
			HTTP struct {
				Paths []struct {
					Path    string `yaml:"path"`
					Backend struct {
						Service struct {
							Name string `yaml:"name"`
						} `yaml:"service"`
						ServiceName string `yaml:"serviceName"` // networking/v1beta1
					} `yaml:"backend"`
				} `yaml:"paths"`
			} `yaml:"http"`
		} `yaml:"rules"`
	} `yaml:"spec"`
}

var workloadKinds = map[string]bool{
	"Deployment": true, "StatefulSet": true, "DaemonSet": true, "ReplicaSet": true, "Job": true, "CronJob": true,
}

type k8sWorkload struct {
	id        string
	namespace string
	labels    map[string]string
}

// k8s parses every document in a YAML file; non-Kubernetes documents are ignored.
// Services and Ingresses are resolved after all files are read (see linkK8s).
func (a *analyzer) k8s(rel string, data []byte) error {
	dec := yaml.NewDecoder(bytes.NewReader(data))
	for {
		var node yaml.Node
		err := dec.Decode(&node)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return nil // not Kubernetes YAML (or templated Helm source); skip quietly
		}
		var obj k8sObject
		if node.Decode(&obj) != nil || obj.APIVersion == "" || obj.Kind == "" || obj.Metadata.Name == "" {
			continue
		}
		if obj.Kind == "Service" {
			var svc struct {
				Spec struct {
					Selector map[string]string `yaml:"selector"`
				} `yaml:"spec"`
			}
			node.Decode(&svc)
			obj.Spec.ServiceSelector = svc.Spec.Selector
		}
		ns := obj.Metadata.Namespace
		if ns == "" {
			ns = "default"
		}
		line := docRoot(&node).Line
		loc := &ir.Location{File: rel, StartLine: &line}

		switch {
		case workloadKinds[obj.Kind]:
			tpl := obj.Spec.Template
			if obj.Kind == "CronJob" {
				tpl = obj.Spec.JobTemplate.Spec.Template
			}
			n := a.b.node("k8s:"+ns+"/"+obj.Metadata.Name, ir.NodeDeployment, obj.Metadata.Name)
			n.Location = loc
			n.Attrs["source"] = "kubernetes"
			n.Attrs["k8sKind"] = obj.Kind
			n.Attrs["namespace"] = ns
			if obj.Spec.Replicas != nil {
				n.Attrs["replicas"] = *obj.Spec.Replicas
			}
			var images []string
			var commands []string
			for _, c := range tpl.Spec.Containers {
				images = append(images, c.Image)
				if role := imageRole(c.Image); role != "" {
					n.Attrs["role"] = role
				}
				if len(c.Command) > 0 || len(c.Args) > 0 {
					commands = append(commands, strings.Join(append(append([]string{}, c.Command...), c.Args...), " "))
				}
			}
			noteLaunch(n.Attrs, commands...)
			if len(images) > 0 {
				n.Attrs["images"] = images
			}
			labels := maps.Clone(tpl.Metadata.Labels)
			if len(labels) == 0 {
				labels = obj.Spec.Selector.MatchLabels
			}
			a.workloads = append(a.workloads, k8sWorkload{id: n.ID, namespace: ns, labels: labels})
		case obj.Kind == "Service":
			a.services = append(a.services, k8sService{name: obj.Metadata.Name, namespace: ns, selector: obj.Spec.ServiceSelector})
		case obj.Kind == "Ingress":
			for _, r := range obj.Spec.Rules {
				for _, p := range r.HTTP.Paths {
					backend := p.Backend.Service.Name
					if backend == "" {
						backend = p.Backend.ServiceName
					}
					a.ingresses = append(a.ingresses, k8sIngress{host: r.Host, path: p.Path, service: backend, namespace: ns, loc: loc})
				}
			}
		}
	}
}

type k8sService struct {
	name, namespace string
	selector        map[string]string
}

type k8sIngress struct {
	host, path, service, namespace string
	loc                            *ir.Location
}

func (a *analyzer) linkK8s() {
	backing := map[string][]string{} // namespace/service -> workload ids
	for _, s := range a.services {
		if len(s.selector) == 0 {
			continue
		}
		for _, w := range a.workloads {
			if w.namespace != s.namespace || !labelsMatch(w.labels, s.selector) {
				continue
			}
			key := s.namespace + "/" + s.name
			backing[key] = append(backing[key], w.id)
			// in-cluster DNS names other services use to reach this workload
			attrs := a.b.nodeIndex[w.id].Attrs
			addToList(attrs, "hostnames", s.name)
			addToList(attrs, "hostnames", s.name+"."+s.namespace)
			addToList(attrs, "hostnames", s.name+"."+s.namespace+".svc.cluster.local")
		}
	}
	for _, in := range a.ingresses {
		host := in.host
		if host == "" {
			host = "*"
		}
		n := a.b.node("ingress:"+host, ir.NodeExternal, host)
		n.Location = in.loc
		n.Attrs["ingress"] = true
		for _, w := range backing[in.namespace+"/"+in.service] {
			e := a.b.edge(n.ID, w, ir.EdgeConnectsTo)
			if in.path != "" {
				addToList(e.Attrs, "paths", in.path)
			}
		}
	}
}

func labelsMatch(labels, selector map[string]string) bool {
	for k, v := range selector {
		if labels[k] != v {
			return false
		}
	}
	return true
}
