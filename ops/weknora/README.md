# WeKnora knowledge stack

WeKnora is TJUClaw's knowledge engine: document ingest, retrieval, and
tenant API keys for the agent runtime (omp). It is not product identity,
not the browser app, and not library ACL. Private library authorization
stays in the Go API. The public crawler keeps its own PostgreSQL.

Pin `WEKNORA_VERSION=v0.8.0` or newer. Do not run `latest`. Do not mount
the Docker socket. Do not enable WeKnora's Docker sandbox.

## Local

```sh
rtk task weknora:up
```

Creates ignored `ops/local/weknora/.env` with durable secrets if missing,
starts the stack, and waits for `http://127.0.0.1:18181/health`.

| Surface | Bind |
| --- | --- |
| Admin UI | `http://127.0.0.1:18180` |
| App / health | `http://127.0.0.1:18181/health` |

First boot: register one admin in the UI, create a knowledge base, mint a
tenant API key. omp talks to the app with `WEKNORA_BASE_URL` and
`WEKNORA_API_KEY` (`X-API-Key`). Models are configured in the WeKnora UI;
point OpenAI-compatible endpoints at NewAPI via `host.docker.internal:3000`.

```sh
rtk task weknora:down
```

Stops containers and keeps volumes.

## Cloud

Copy `ops/ansible/weknora.example.yml` to ignored `ops/local/weknora.yml`.
Listeners stay on loopback. This stack needs about 1.4 GiB of memory
ceiling and must not share the 2 GiB core host with identity, NewAPI,
crawler, and the API. Use a host with spare RAM, then:

```sh
rtk task ops:weknora:deploy
```

Production can use one remotely managed Cloudflare Tunnel for both public
hostnames. Keep the UI and app listeners on loopback and provide the Tunnel
Token through ignored Ansible variables or Ansible Vault. Configure the
Tunnel ingress in Cloudflare as follows:

| Hostname | Origin inside the WeKnora Compose network |
| --- | --- |
| `weknora-map.agentwego.com` | `http://frontend:80` |
| `weknora-api.agentwego.com` | `http://app:8080` |

Set `weknora_tunnel_enabled: true` and `weknora_tunnel_token` in the ignored
`ops/local/weknora.yml`, then run `rtk task ops:weknora:deploy`. The token is
mounted as a Compose secret and is never placed in the tracked Compose file.
The API hostname exposes the WeKnora app directly, so protect it with the
WeKnora API key and Cloudflare controls before sharing it.

In the Cloudflare Tunnel dashboard, add these public hostnames to the same
remotely managed Tunnel. The origin names below are Docker Compose service
names and are resolved inside the WeKnora network.

```text
weknora-map.agentwego.com  -> http://frontend:80
weknora-api.agentwego.com  -> http://app:8080
```

The API route must not be configured as a catch-all for other hostnames. Keep
the final unmatched rule as `http_status:404`.

Without the Tunnel, administer production through an SSH tunnel:

```sh
ssh -N -L 18180:127.0.0.1:18180 -L 18181:127.0.0.1:18181 YOUR_SSH_HOST
```
