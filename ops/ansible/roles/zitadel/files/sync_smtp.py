import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def sync_smtp():
    base_dir = sys.argv[1] if len(sys.argv) > 1 else '/opt/tjuclaw-zitadel'
    listen_addr = sys.argv[2] if len(sys.argv) > 2 else '127.0.0.1:8085'
    host_header = sys.argv[3] if len(sys.argv) > 3 else 'auth.tjuclaw.cloud'

    pat_file = os.path.join(base_dir, 'bootstrap/owner.pat')
    if not os.path.exists(pat_file):
        raise RuntimeError(f"Required bootstrap PAT file not found: {pat_file}")

    with open(pat_file, 'r', encoding='utf-8') as f:
        token = f.read().strip()
    if not token:
        raise RuntimeError(f"Required bootstrap PAT file is empty: {pat_file}")

    smtp_data_raw = sys.stdin.read().strip()
    if not smtp_data_raw:
        raise RuntimeError("Missing required SMTP configuration payload on stdin")

    try:
        smtp_cfg = json.loads(smtp_data_raw)
    except Exception as exc:
        raise RuntimeError(f"Malformed SMTP configuration JSON: {exc}")

    sender_addr = smtp_cfg.get('from_address', '').strip()
    if not sender_addr:
        raise RuntimeError("Missing required from_address in SMTP configuration")
    sender_name = smtp_cfg.get('from_name', 'TJUClaw').strip() or 'TJUClaw'
    host = smtp_cfg.get('host', '').strip()
    if not host:
        raise RuntimeError("Missing required host in SMTP configuration")
    auth = smtp_cfg.get('auth', 'plain')
    if auth not in ('plain', 'none'):
        raise RuntimeError(f"Unsupported SMTP authentication mode: {auth}")
    user = smtp_cfg.get('username', '').strip()
    password = smtp_cfg.get('password', '')
    if auth == 'plain' and (not user or not password):
        raise RuntimeError("Authenticated SMTP requires username and password")
    tls = bool(smtp_cfg.get('tls', True))
    reply_to = smtp_cfg.get('reply_to_address', sender_addr).strip() or sender_addr

    base_url = f"http://{listen_addr}"

    def api_call(path, data=None, method='GET'):
        url = f"{base_url}{path}"
        req = urllib.request.Request(url, method=method)
        req.add_header('Authorization', f'Bearer {token}')
        req.add_header('Host', host_header)
        if data is not None:
            req.add_header('Content-Type', 'application/json')
            req.data = json.dumps(data).encode('utf-8')
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read().decode('utf-8')
                return resp.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            err_body = e.read().decode('utf-8')
            parsed_err = None
            try:
                parsed_err = json.loads(err_body) if err_body else {}
            except Exception:
                pass
            return e.code, parsed_err or err_body
        except Exception as e:
            raise RuntimeError(f"ZITADEL API request to {path} failed: {e}")

    # ZITADEL v4.17.3 has a broken SMTP update projection (SQLSTATE 42601).
    # Always create and activate a replacement; never PUT an existing provider.
    create_payload = {
        "senderAddress": sender_addr,
        "senderName": sender_name,
        "tls": tls,
        "host": host,
        "user": user,
        "replyToAddress": reply_to,
        "description": "Configured SMTP",
        **({'none': {}} if auth == 'none' else {'plain': {'password': password}}),
    }
    create_status, create_resp = api_call('/admin/v1/email/smtp', data=create_payload, method='POST')
    if create_status != 200 or not isinstance(create_resp, dict) or 'id' not in create_resp:
        raise RuntimeError(f"Failed to create SMTP provider (HTTP {create_status}): {create_resp}")

    new_id = create_resp['id']

    # Activate the new provider
    act_status, act_resp = api_call(f'/admin/v1/smtp/{new_id}/_activate', data={}, method='POST')
    if act_status != 200:
        raise RuntimeError(f"Failed to activate SMTP provider {new_id} (HTTP {act_status}): {act_resp}")

    # Note: Previous providers are intentionally preserved for rollback / audit history.
    print(json.dumps({
        "changed": True,
        "provider_id": new_id,
        "status": "created_and_activated"
    }))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(sync_smtp())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
