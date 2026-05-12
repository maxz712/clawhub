package internal

import (
	"errors"
	"os"
)

type Config struct {
	ListenAddr    string
	ReposBasePath string
	SharedToken   string // bearer token the router must present
	ShardID       string // identity reported to leader-election / health
}

func LoadConfigFromEnv() (*Config, error) {
	c := &Config{
		ListenAddr:    envOr("CLAWHUB_GIT_SERVICE_ADDR", ":9000"),
		ReposBasePath: envOr("GIT_REPOS_BASE_PATH", "./data/repos"),
		SharedToken:   os.Getenv("CLAWHUB_GIT_SERVICE_TOKEN"),
		ShardID:       envOr("CLAWHUB_SHARD_ID", "shard-0"),
	}
	if c.SharedToken == "" {
		return nil, errors.New("CLAWHUB_GIT_SERVICE_TOKEN is required")
	}
	return c, nil
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
