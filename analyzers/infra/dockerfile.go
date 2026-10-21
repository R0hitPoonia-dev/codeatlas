package main

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// dockerLaunch is what a Dockerfile's final stage starts.
type dockerLaunch struct {
	entrypoint, cmd string
	// jar files COPY / ADD put into the image, by the build's own file name
	// (target/producer-*.jar -> producer-*.jar) even when the command runs /app/app.jar
	jars []string
}

// dockerfileLaunch reads the Dockerfile a compose service is built from (rel to the repo
// root). Nothing else from the Dockerfile is kept: ENV and ARG values can hold credentials.
func (a *analyzer) dockerfileLaunch(rel string) (dockerLaunch, bool) {
	full := filepath.Join(a.root, filepath.FromSlash(rel))
	if r, err := filepath.Rel(a.root, full); err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return dockerLaunch{}, false // a build context outside the repo
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return dockerLaunch{}, false
	}
	var entrypoint, cmd string
	var jars []string
	for _, line := range instructions(string(data)) {
		word, rest, _ := strings.Cut(line, " ")
		rest = strings.TrimSpace(rest)
		switch strings.ToUpper(word) {
		case "FROM": // a new stage: only the last one is the image that runs
			entrypoint, cmd, jars = "", "", nil
		case "ENTRYPOINT":
			entrypoint = execForm(rest)
		case "CMD":
			cmd = execForm(rest)
		case "COPY", "ADD":
			args := strings.Fields(rest)
			for len(args) > 0 && strings.HasPrefix(args[0], "--") {
				args = args[1:]
			}
			if strings.HasPrefix(rest, "[") {
				var parts []string
				if json.Unmarshal([]byte(rest), &parts) == nil {
					args = parts
				}
			}
			for i := 0; i+1 < len(args); i++ { // the last argument is the destination
				if strings.HasSuffix(strings.ToLower(args[i]), ".jar") {
					jars = append(jars, path.Base(args[i]))
				}
			}
		}
	}
	return dockerLaunch{entrypoint, cmd, jars}, true
}

// instructions are a Dockerfile's lines with comments dropped and `\` continuations joined.
func instructions(text string) []string {
	var out []string
	var cur strings.Builder
	for _, raw := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasSuffix(line, "\\") {
			cur.WriteString(strings.TrimSuffix(line, "\\"))
			cur.WriteString(" ")
			continue
		}
		cur.WriteString(line)
		if s := strings.TrimSpace(cur.String()); s != "" {
			out = append(out, s)
		}
		cur.Reset()
	}
	if s := strings.TrimSpace(cur.String()); s != "" {
		out = append(out, s)
	}
	return out
}

// execForm turns ["java", "-jar", "app.jar"] into "java -jar app.jar"; shell form stays as written.
func execForm(s string) string {
	if strings.HasPrefix(s, "[") {
		var parts []string
		if json.Unmarshal([]byte(s), &parts) == nil {
			return strings.Join(parts, " ")
		}
	}
	return s
}
