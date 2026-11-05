"""Shared bits of the memory probes: where data goes, the verdict file, the node the hooks run on."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get('HUB_PROBES', Path.home() / 'hub-data' / 'probes')) / 'memory'
WORK = Path(os.environ.get('PROBE_WORK', '/tmp/hub-probes')) / 'memory'
# Hooks run `node` from PATH, and ~/.local/bin leads it (P2 asks about exactly this node).
NODE = os.environ.get('PROBE_NODE', str(Path.home() / '.local' / 'bin' / 'node'))
sys.path.append(str(HERE.parent / 'platform'))  # the sandbox and mock API of slice 04 (after this dir: own common)


def platform_common():
    """probes/platform/common.py (engines, claude_version) — same module name as this one, so loaded by path."""
    spec = importlib.util.spec_from_file_location('platform_common', HERE.parent / 'platform' / 'common.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def biggest_errors_md():
    """errors.md of project A (the multi-session one) in the hub-data copy: the largest of them."""
    return max((Path.home() / 'hub-data' / 'hub' / 'projects').glob('*/memory/errors.md'), key=lambda p: p.stat().st_size)


def node_version(node=NODE):
    return subprocess.run([node, '--version'], capture_output=True, text=True).stdout.strip()


def workdir(probe, fresh=True):
    d = WORK / probe
    if fresh and d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True, exist_ok=True)
    return d


def pct(values, q):
    """Nearest-rank percentile (q in 0..100) of a non-empty list."""
    s = sorted(values)
    return s[min(len(s) - 1, max(0, -(-len(s) * q // 100) - 1))]


def save(probe, verdict, numbers, criterion, path, details=None, method=''):
    """path — what the plan does with this verdict (the «при провале» branch or the passed one)."""
    DATA.mkdir(parents=True, exist_ok=True)
    out = {'probe': probe, 'verdict': verdict, 'numbers': numbers, 'criterion': criterion, 'path': path,
           'method': method, 'details': details or {}, 'date': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
    (DATA / f'{probe}.json').write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
    print(f'{probe}: {verdict} — ' + ', '.join(f'{k}={v}' for k, v in numbers.items()))
    return out
