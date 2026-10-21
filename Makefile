COMPOSE := docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env

.PHONY: build web analyzers test test-integration test-analyzers up down logs scan-demo scanner-image

# Server, CLI, UI and all analyzers into ./bin (+ the jar / TS dist in place).
build: web analyzers
	cd core && go build -o ../bin/codeatlas-api ./cmd/codeatlas-api
	cd core && go build -o ../bin/codeatlas ./cmd/codeatlas

web:
	cd web && npm ci --no-audit --no-fund && npm run build

analyzers:
	cd analyzers/java && mvn -q -DskipTests package
	cd analyzers/typescript && npm ci --no-audit --no-fund && npm run build
	cd analyzers/infra && go build -o ../../bin/codeatlas-infra .

test: test-analyzers
	cd core && go vet ./... && go test ./...
	cd web && npm run typecheck && npm test

test-analyzers:
	cd analyzers/java && mvn -q test
	cd analyzers/typescript && npm test
	cd analyzers/infra && go vet ./... && go test ./...

# Needs a Postgres you can create schemas in, e.g.
#   make test-integration DB=postgres://postgres@127.0.0.1:5432/codeatlas_test?sslmode=disable
test-integration:
	cd core && CODEATLAS_TEST_DATABASE_URL='$(DB)' go test -count=1 ./...

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f api

# Analyse demo/shop and upload it. Needs CODEATLAS_URL and CODEATLAS_TOKEN (an admin API token).
scan-demo: build
	PATH="$(CURDIR)/bin:$$PATH" ./bin/codeatlas scan demo/shop --repo shop --commit demo --branch main

scanner-image:
	docker build -f Dockerfile.scanner -t codeatlas-scanner .
