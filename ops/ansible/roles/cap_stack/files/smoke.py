import hashlib
import json
from pathlib import Path
import time
import urllib.request
import urllib.error

# Implements the public widget's FNV-1a/xorshift challenge expansion for one owned smoke check.
def prng(seed, length):
    value = 2166136261
    for c in seed:
        value = ((value ^ ord(c)) * 16777619) & 0xffffffff
    result = ''
    while len(result) < length:
        value ^= (value << 13) & 0xffffffff
        value ^= value >> 17
        value ^= (value << 5) & 0xffffffff
        result += format(value, '08x')
    return result[:length]

key = json.loads(Path('/opt/tjuclaw-cap/site-key.json').read_text())
base = 'http://127.0.0.1:3300/' + key['siteKey']
def post(path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as err:
        return err.code, json.load(err)
status, challenge = post('/challenge', {})
assert status == 200
spec, token = challenge['challenge'], challenge['token']
assert spec['c'] <= 100 and spec['d'] <= 4
solutions = []
started = time.monotonic()
for i in range(1, spec['c'] + 1):
    salt = prng(token + str(i), spec['s'])
    target = prng(token + str(i) + 'd', spec['d'])
    nonce = 0
    while not hashlib.sha256((salt + str(nonce)).encode()).hexdigest().startswith(target):
        nonce += 1
        if nonce % 100000 == 0:
            assert time.monotonic() - started < 45, 'Bounded smoke solve timed out'
    solutions.append(nonce)
status, redeemed = post('/redeem', {'token': token, 'solutions': solutions})
assert status == 200 and redeemed.get('success') is True
body = {'secret': key['secretKey'], 'response': redeemed['token']}
status, verified = post('/siteverify', body)
assert status == 200 and verified.get('success') is True
status, replay = post('/siteverify', body)
assert status != 200 and not replay.get('success')
print(json.dumps({'challenge_solved': len(solutions), 'redeem': True, 'siteverify': True, 'replay_rejected': True, 'seconds': round(time.monotonic() - started, 2)}))
