#!/usr/bin/python3
"""Executable public-CLI fixture shared by TypeScript and native CLI tests."""
import base64
import json
from pathlib import Path
import shutil
import sys

root = Path(__file__).parent
mode = (root / 'mode').read_text().strip() if (root / 'mode').exists() else ''
a = sys.argv[1:]
if a == ['--version']:
    print((root / 'version').read_text().strip() if (root / 'version').exists()
          else 'audb 0.2.1' if mode == 'old' else 'audb 0.3.0')
    sys.exit()
target = a[a.index('--device') + 1] if '--device' in a else None
payload = sys.stdin.buffer.read()
with (root / 'calls.jsonl').open('a') as out:
    out.write(json.dumps({'args': a, 'stdin': base64.b64encode(payload).decode()}) + '\n')
if mode == 'lost':
    sys.exit(1)
if mode == 'error':
    print(json.dumps({'schemaVersion': 1, 'ok': False, 'deviceId': target,
          'error': {'code': 'AGENT_UNAVAILABLE', 'message': 'agent unavailable'},
          'data': {'changed': False, 'partial': True}}))
    sys.exit(2)
data = {'changed': False, 'output': 'exact output\n\n'}
if 'device' in a:
    if 'current' in a:
        data = {'id': (root / 'default').read_text().strip() if (root / 'default').exists() else 'emulator'}
    else:
        data = [{'id': d, 'name': d, 'kind': k, 'state': 'unknown'}
                for d, k in [('phone', 'physical'), ('emulator', 'emulator')]]
if 'screenshot' in a:
    output = Path(a[a.index('--output') + 1])
    shutil.copyfile(root / 'screen.png', output)
    output.chmod(0o600)
    data = {'path': str(output), 'width': 720, 'height': 1600}
if 'package' in a:
    data = {'changed': False}
if 'package' in a and 'list' in a:
    data = {'packages': ['ru.example.app']}
print(json.dumps({'schemaVersion': 2 if mode == 'schema' else 1,
                 'ok': True, 'deviceId': target, 'data': data}))

if mode == 'success-nonzero':
    sys.exit(3)
