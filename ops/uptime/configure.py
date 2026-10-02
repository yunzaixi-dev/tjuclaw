"""Configure Uptime Kuma from a JSON description: admin account, monitors grouped
by layer, and one public status page.

Run it against the dashboard through an SSH tunnel:

    ssh -N -L 13001:127.0.0.1:3001 HOST &
    uv run --no-project --with 'python-socketio[client]' ops/uptime/configure.py \
        --monitors ops/local/uptime-monitors.json --password-file ops/local/uptime-admin-password.txt

Monitors are matched by name, so running it again only adds what is missing and
saves the status page. It never deletes or edits an existing monitor.
"""

import argparse
import json
import re
import sys
import time

import socketio

# Defaults the web client sends for a new monitor. A field this server version
# does not store is dropped when the server says so.
DEFAULTS = {
    "method": "GET", "interval": 60, "retryInterval": 30, "resendInterval": 0, "maxretries": 2, "timeout": 20,
    "notificationIDList": {}, "ignoreTls": False, "upsideDown": False, "expiryNotification": False, "maxredirects": 5,
    "accepted_statuscodes": ["200-299"], "dns_resolve_type": "A", "dns_resolve_server": "119.29.29.29",
    "httpBodyEncoding": "json", "packetSize": 56, "active": True, "conditions": [], "kafkaProducerBrokers": [],
    "kafkaProducerSaslOptions": {"mechanism": "None"}, "rabbitmqNodes": [], "gamedigGivenPortOnly": True,
    "cacheBust": False, "description": None, "parent": None, "authMethod": None,
    "oauth_auth_method": "client_secret_basic", "docker_container": "", "docker_host": None, "proxyId": None,
    "mqttUsername": "", "mqttPassword": "", "mqttTopic": "", "mqttSuccessMessage": "", "mqttCheckType": "keyword",
    "databaseConnectionString": "", "databaseQuery": None, "jsonPath": "$", "expectedValue": None,
    "jsonPathOperator": "==", "keyword": "", "invertKeyword": False, "hostname": None, "port": None,
    "headers": None, "body": None, "basic_auth_user": None, "basic_auth_pass": None,
    "tlsCa": None, "tlsCert": None, "tlsKey": None, "snmpVersion": "2c", "snmpOid": None,
    "rabbitmqUsername": "", "rabbitmqPassword": "", "smtpSecurity": None,
    "ping_count": 3, "ping_numeric": True, "ping_per_request_timeout": 2, "ipFamily": None,
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:13001")
    parser.add_argument("--monitors", required=True)
    parser.add_argument("--password-file", required=True)
    parser.add_argument("--username", default="admin")
    args = parser.parse_args()
    with open(args.monitors, encoding="utf-8") as handle:
        wanted = json.load(handle)
    with open(args.password_file, encoding="utf-8") as handle:
        password = handle.read().strip()
    if len(password) < 12:
        print("the admin password must be at least 12 characters", file=sys.stderr)
        return 2

    client = socketio.Client(reconnection=False)
    known: dict[str, int] = {}

    @client.on("monitorList")
    def monitor_list(monitors):
        known.update({monitor["name"]: monitor["id"] for monitor in monitors.values()})

    client.connect(args.url, transports=["websocket"])

    def call(event, *data):
        return client.call(event, data if len(data) != 1 else data[0], timeout=30) if data else client.call(event, timeout=30)

    def check(result, what):
        if not result.get("ok"):
            # The server echoes the whole statement; keep only its reason.
            reason = re.sub(r"insert into.*values \(.*\) - ", "", str(result.get("msg")), flags=re.S)
            raise SystemExit(f"{what}: {reason}")
        return result

    if call("needSetup"):
        check(call("setup", args.username, password), "setup")
        print("admin account created")
    check(call("login", {"username": args.username, "password": password, "token": ""}), "login")
    time.sleep(1.5)  # the monitor list follows the login

    defaults = dict(DEFAULTS)

    def ensure(monitor):
        if monitor["name"] in known:
            return known[monitor["name"]]
        payload = {**defaults, **monitor}
        result = call("add", payload)
        for _ in range(40):
            missing = re.search(r"has no column named (\w+)", str(result.get("msg")))
            if result.get("ok") or not missing:
                break
            column = missing.group(1)
            camel = re.sub(r"_([a-z])", lambda match: match.group(1).upper(), column)
            key = next((name for name in payload if name in (column, camel) or name.lower() == camel.lower()), None)
            if key is None:
                break
            defaults.pop(key, None)
            payload.pop(key)
            result = call("add", payload)
        check(result, f"add {monitor['name']}")
        known[monitor["name"]] = result["monitorID"]
        print(f"added {monitor['name']}")
        return result["monitorID"]

    groups = []
    for weight, group in enumerate(wanted["groups"], start=1):
        parent = ensure({"type": "group", "name": group["name"]})
        ids = []
        for monitor in group["monitors"]:
            ids.append(ensure({
                "type": "http", "parent": parent, "name": monitor["name"], "url": monitor["url"],
                "accepted_statuscodes": monitor.get("accepted", ["200-299"]),
                "interval": monitor.get("interval", 60), "description": monitor.get("description"),
                "expiryNotification": monitor.get("certificate_expiry", False),
            }))
        groups.append({"name": group["name"], "weight": weight, "monitorList": [{"id": value} for value in ids]})

    page = wanted["status_page"]
    slug = page["slug"]
    current = call("getStatusPage", slug)
    if not current.get("ok"):
        check(call("addStatusPage", page["title"], slug), "addStatusPage")
        current = check(call("getStatusPage", slug), "getStatusPage")
        print("status page created")
    config = {**current.get("config", {}), "slug": slug, "title": page["title"],
              "description": page.get("description"), "published": True, "showTags": False,
              "showPoweredBy": False, "theme": "auto", "autoRefreshInterval": 300}
    check(call("saveStatusPage", slug, config, config.get("icon") or "/icon.svg", groups), "saveStatusPage")
    print(f"status page saved with {sum(len(group['monitorList']) for group in groups)} monitors")
    client.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())
