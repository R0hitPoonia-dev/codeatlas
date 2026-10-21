# Single image: Go API + built web UI (served by the API from /app/web).

FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS api
WORKDIR /src
COPY core/go.mod core/go.sum ./
RUN go mod download
COPY core/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/codeatlas-api ./cmd/codeatlas-api

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=api /out/codeatlas-api /app/codeatlas-api
COPY --from=web /web/dist /app/web
ENV CODEATLAS_HTTP_ADDR=:8080 \
    CODEATLAS_WEB_DIR=/app/web
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/app/codeatlas-api"]
