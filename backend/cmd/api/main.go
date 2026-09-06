package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"gitlab.tju.edu.cn/3023244020/tjuclaw/backend/internal/auth"
)

func handler(gateway ...*auth.Gateway) http.Handler {
	mux := http.NewServeMux()
	if len(gateway) > 0 && gateway[0] != nil {
		gateway[0].Register(mux)
	} else {
		for _, path := range []string{"/auth/", "/kratos/"} {
			mux.HandleFunc(path, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Cache-Control", "no-store")
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"error":{"id":"auth_not_configured"}}`))
			})
		}
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte("{\"status\":\"ok\"}\n"))
	})
	return mux
}

func main() {
	var gateway *auth.Gateway
	if upstream := os.Getenv("KRATOS_PUBLIC_URL"); upstream != "" {
		var err error
		gateway, err = auth.New(upstream, os.Getenv("APP_PUBLIC_URL"))
		if err != nil {
			log.Fatal(err)
		}
	}
	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	server := &http.Server{
		Addr: addr, Handler: handler(gateway),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Printf("API listening on %s", addr)
	failed := make(chan error, 1)
	go func() { failed <- server.ListenAndServe() }()
	select {
	case err := <-failed:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			log.Printf("shutdown: %v", err)
			_ = server.Close()
		}
	}
}
