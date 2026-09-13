#!/usr/bin/env python3
"""Read-only ownership checks before managing the isolated Cap stack."""
import json
import pathlib
import socket
import subprocess
import sys

base = pathlib.Path(sys.argv[1])
project, port, simulate = sys.argv[2], int(sys.argv[3]), sys.argv[4] == "true"
marker = base / ".managed-by-ansible"
if base.is_symlink() or base.resolve() != base:
    raise SystemExit("Refusing a symlink or non-canonical Cap directory")
if base.exists():
    if not base.is_dir():
        raise SystemExit("Cap path is not a directory")
    if any(base.iterdir()) and (not marker.is_file() or marker.read_text().strip() != "tjuclaw-cap-v1"):
        raise SystemExit("Refusing to adopt an unmanaged non-empty Cap directory")
    for name in ("compose.yaml", ".env.cap", ".managed-by-ansible"):
        if (base / name).is_symlink():
            raise SystemExit("Refusing a symlinked Cap configuration")
    if (base / "compose.yaml").exists() and not (base / ".env.cap").exists():
        raise SystemExit("Existing Cap deployment is missing its durable secret")
if simulate:
    print("Local ownership preflight passed")
    sys.exit(0)

subprocess.run(["docker", "compose", "version"], check=True, stdout=subprocess.DEVNULL)

def inspect(kind, name):
    result = subprocess.run(["docker", kind, "inspect", name], capture_output=True, text=True)
    if result.returncode:
        if "no such" not in result.stderr.lower() and "not found" not in result.stderr.lower():
            raise SystemExit("Docker ownership inspection failed")
        return None
    return json.loads(result.stdout)[0]

app = None
for kind, name in (("container", project + "-app"), ("container", project + "-valkey"),
                   ("network", project + "-internal"), ("network", project + "-access"),
                   ("volume", project + "-valkey-data")):
    obj = inspect(kind, name)
    if obj is None:
        continue
    labels = obj.get("Config", {}).get("Labels", {}) if kind == "container" else obj.get("Labels", {})
    if not marker.exists() or (labels or {}).get("com.docker.compose.project") != project:
        raise SystemExit("Refusing to adopt an unrelated Docker resource: " + name)
    if name == project + "-app":
        app = obj

with socket.socket() as probe:
    try:
        probe.bind(("127.0.0.1", port))
    except OSError:
        bindings = (app or {}).get("NetworkSettings", {}).get("Ports", {}).get("3000/tcp") or []
        if not (app or {}).get("State", {}).get("Running") or not any(
            b.get("HostIp") == "127.0.0.1" and b.get("HostPort") == str(port) for b in bindings
        ):
            raise SystemExit("Cap port is occupied by an unrelated listener")
print("Cap ownership and private port preflight passed")
