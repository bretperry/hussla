// `hussla health`: exits 0 when this machine's Hussla answers /healthz, for the Docker HEALTHCHECK.
// In the app: Container Manager's "healthy" badge; `docker compose ps` in the install guides' last check.
// Used by: main.go; the Dockerfile's HEALTHCHECK (a distroless image has no shell or curl).
// Uses: the home-network port, else the local listener's port, on 127.0.0.1.

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"
)

// healthTimeout is how long the check waits for an answer before calling the server unhealthy.
const healthTimeout = 3 * time.Second

func checkHealth(env settings) error {
	port := env.homePort
	if port == "" {
		port = env.localPort
	}
	if port == "" || port == "0" {
		return errors.New("no fixed port to check: set HUSSLA_HOME_PORT or HUSSLA_LOCAL_PORT")
	}
	ctx, cancel := context.WithTimeout(context.Background(), healthTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort("127.0.0.1", port)+"/healthz", http.NoBody)
	if err != nil {
		return fmt.Errorf("health request: %w", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("not answering: %w", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("answered %d", response.StatusCode)
	}
	return nil
}
