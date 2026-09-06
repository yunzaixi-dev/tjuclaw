FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /api ./cmd/api

FROM alpine:3.23
RUN apk add --no-cache ca-certificates
COPY --from=build /api /usr/local/bin/api
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
