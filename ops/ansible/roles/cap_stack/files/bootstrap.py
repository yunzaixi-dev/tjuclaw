import base64
import json
import os
from pathlib import Path
import urllib.request

base = 'http://127.0.0.1:3300'
root = Path('/opt/tjuclaw-cap')
admin = next(line.split('=', 1)[1] for line in (root / '.env.cap').read_text().splitlines() if line.startswith('ADMIN_KEY='))
def request(path, body=None, authorization=None):
    headers = {'Content-Type': 'application/json'}
    if authorization:
        headers['Authorization'] = authorization
    req = urllib.request.Request(base + path, headers=headers, data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=15) as result:
        return json.load(result)
login = request('/auth/login', {'admin_key': admin})
assert login.get('success') is True
bearer = 'Bearer ' + base64.b64encode(json.dumps({'token': login['session_token'], 'hash': login['hashed_token']}).encode()).decode()
key_path = root / 'site-key.json'
if not key_path.exists():
    keys = request('/server/keys', authorization=bearer)
    assert not any(key.get('name') == 'TJUClaw' for key in keys), 'Existing site secret must be recovered, not rotated'
    key = request('/server/keys', {'name': 'TJUClaw', 'corsOrigins': ['https://app.tjuclaw.cloud']}, bearer)
    assert key.get('siteKey') and key.get('secretKey')
    fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(key, out)
        out.write('\n')
key = json.loads(key_path.read_text())
keys = request('/server/keys', authorization=bearer)
assert any(item['siteKey'] == key['siteKey'] for item in keys)
challenge = request('/' + key['siteKey'] + '/challenge', {})
assert isinstance(challenge.get('token'), str) and challenge['token']
assert challenge.get('challenge') or challenge.get('challenges') or challenge.get('c') or len(challenge) > 1
print(json.dumps({'admin_login': True, 'site_key_persisted': True, 'challenge_created': True, 'challenge_fields': list(challenge)}))
