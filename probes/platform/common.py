"""Shared bits of the probe scripts: where data goes, the verdict file, the Claude Code version."""
import json
import os
import subprocess
import time
from pathlib import Path

DATA = Path(os.environ.get('HUB_PROBES', Path.home() / 'hub-data' / 'probes')) / 'platform'
WORK = Path(os.environ.get('PROBE_WORK', '/tmp/hub-probes'))


def claude_version():
    try:
        return subprocess.run(['claude', '--version'], capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception as e:  # noqa: BLE001 — only recorded
        return f'? ({e})'


def workdir(probe):
    d = WORK / probe
    d.mkdir(parents=True, exist_ok=True)
    return d


def save(probe, verdict, numbers, criterion, details=None, method=''):
    DATA.mkdir(parents=True, exist_ok=True)
    out = {'probe': probe, 'verdict': verdict, 'numbers': numbers, 'criterion': criterion, 'method': method,
           'details': details or {}, 'claude_version': claude_version(),
           'date': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
    (DATA / f'{probe}.json').write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
    print(f'{probe}: {verdict} — ' + ', '.join(f'{k}={v}' for k, v in numbers.items()))
    return out
