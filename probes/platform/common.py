"""Shared bits of the probe scripts: where data goes, the verdict file, the Claude Code version."""
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

DATA = Path(os.environ.get('HUB_PROBES', Path.home() / 'hub-data' / 'probes')) / 'platform'
WORK = Path(os.environ.get('PROBE_WORK', '/tmp/hub-probes'))


def desktop_claude():
    """The engine the Desktop app bundles (newest), or None: Desktop sessions run it, not the CLI on PATH."""
    found = sorted(Path.home().glob('.config/Claude/claude-code/*/*/claude'), key=lambda p: p.stat().st_mtime)
    return str(found[-1]) if found else None


def engines():
    """[(label, binary)] — the CLI and, if present, the Desktop engine."""
    out = [('cli', 'claude')]
    if desktop_claude():
        out.append(('desktop', desktop_claude()))
    return out


def claude_version(binary='claude'):
    try:
        return subprocess.run([binary, '--version'], capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception as e:  # noqa: BLE001 — only recorded
        return f'? ({e})'


def workdir(probe, fresh=True):
    d = WORK / probe
    if fresh and d.exists():
        shutil.rmtree(d)
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
