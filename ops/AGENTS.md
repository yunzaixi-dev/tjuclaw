# Operations Knowledge Base

## OVERVIEW

`ops/` owns Ansible, auth stacks, CI release contracts, and isolated WeKnora
deployment material. It contains high-risk remote operations and ignored secrets.

## WHERE TO LOOK

| Need | Location |
| --- | --- |
| Ops overview | `README.md` |
| Ansible entry/config | `ansible/README.md`, `ansible/ansible.cfg` |
| API artifact deployment | `ansible/DEPLOY.md`, `playbooks/deploy-api.yml` |
| Service ownership/ports | `ansible/SERVICES.md` |
| Active auth policy | `auth/README.md` |
| WeKnora isolation | `weknora/README.md`, `weknora/compose.yaml` |
| CI/release rules | `ci/README.md` |

## CONVENTIONS

- Real inventories and variables live only under ignored `ops/local/`; use
  confirmed SSH aliases and host keys. `task ops:discover` is read-only.
- Run `rtk task ops:check` and `rtk task ops:test` before remote changes.
  `rtk task ops:origin:render` only creates a local HAProxy candidate.
- Production API deployment accepts a verified Linux artifact from the same CI
  run, `release` provenance, SHA-256 checks, and dedicated deployment SSH inputs.
  API, Web, Docs, Draw, and Crawler releases are separate workflows.
- Kratos is the active identity authority; ZITADEL is a paired rollback/candidate
  stack and deployment does not itself switch the API provider.
- WeKnora binds UI/app to loopback `18180/18181`, uses a pinned version, keeps its
  own database, and must not enable Docker sandbox or share the 2 GiB core host.

## ANTI-PATTERNS

- Never commit, print, or pass secrets from `ops/local/`, auth env files, SMTP,
  Cap, database, API, or WeKnora credentials through logs or command arguments.
- Do not use guessed inventories, personal SSH keys, `latest` images, destructive
  Compose resets, or unconditional shell commands that hide state differences.
- Do not call syntax checks, health checks, local Compose, or a generated proxy
  candidate proof of a live deployment or successful auth/mail/EdgeOne path.
- Do not share databases between Kratos, API, Crawler, WeKnora, or regions.
