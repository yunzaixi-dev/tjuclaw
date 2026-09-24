# Conditional retrieval gateway Tunnel example

`config.example.yml` is a tracked, non-deployable example for a named
Cloudflare Tunnel. It is intentionally conditional: the hostname is the
reserved placeholder `retrieval-gateway.example.invalid`, the tunnel ID and
credentials path are placeholders, and the local service port is an example
for an approved authenticated retrieval gateway only.

The example must not be used to expose the WeKnora UI, WeKnora app, admin
surface, database, or any unauthenticated raw service. It contains no token,
secret, API key, DNS record, or production hostname. The final ingress entry is
a catch-all `http_status:404`; keep it last so unapproved paths fail closed.

Before use, verify Cloudflare account ownership, zone ownership, hostname
ownership, the named Tunnel identity, and the approved retrieval gateway's
authentication and loopback listener. Obtain explicit approval for the exact
route and confirm that the gateway, not WeKnora directly, enforces identity and
authorization. Do not create a Tunnel, change DNS, or deploy this example as
part of repository tests.
