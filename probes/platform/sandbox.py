"""Sandbox for platform probes: its own HOME and CLAUDE_CONFIG_DIR, a fake API key and the scripted mock API
(mockapi.py). Real ~/.claude, credentials and the installed plugins are never read or written."""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
FAKE_KEY = 'sk-ant-api03-probe-' + 'x' * 60 + '-mockAA'


class Sandbox:
    def __init__(self, root, settings=None, trust=()):
        self.root = Path(root).resolve()
        if self.root.exists():
            shutil.rmtree(self.root)
        self.home = self.root / 'home'
        self.config = self.home / '.claude'
        self.config.mkdir(parents=True)
        self.mock = None
        self.port = None
        self.write_settings(settings or {})
        self.state = {
            'hasCompletedOnboarding': True, 'theme': 'dark', 'numStartups': 5,
            'customApiKeyResponses': {'approved': [FAKE_KEY[-20:]], 'rejected': []},
            'bypassPermissionsModeAccepted': True, 'projects': {},
        }
        for d in trust:
            self.trust(d)

    def write_settings(self, settings):
        (self.config / 'settings.json').write_text(json.dumps(settings, indent=2))

    def trust(self, d):
        self.state['projects'][str(Path(d).resolve())] = {
            'hasTrustDialogAccepted': True, 'hasCompletedProjectOnboarding': True, 'allowedTools': []}
        (self.config / '.claude.json').write_text(json.dumps(self.state, indent=2))

    def start_mock(self, scenario, log):
        sc = self.root / f'scenario-{Path(log).stem}.json'
        sc.write_text(json.dumps(scenario, ensure_ascii=False, indent=2))
        self.mock = subprocess.Popen([sys.executable, '-I', str(HERE / 'mockapi.py'), str(sc), str(log)],
                                     stdout=subprocess.PIPE, text=True)
        self.port = int(self.mock.stdout.readline())
        return self.port

    def stop_mock(self):
        if self.mock:
            self.mock.terminate()
            self.mock.wait()
            self.mock = None

    def env(self, **extra):
        e = {k: os.environ[k] for k in ('PATH', 'LANG', 'TERM', 'USER', 'SHELL', 'TMPDIR') if k in os.environ}
        e.update({
            'HOME': str(self.home), 'CLAUDE_CONFIG_DIR': str(self.config),
            'ANTHROPIC_API_KEY': FAKE_KEY, 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{self.port}',
            'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1',
            'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1',
        })
        e['PATH'] = str(Path.home() / '.local/bin') + ':' + e.get('PATH', '/usr/bin:/bin')
        e.update({k: str(v) for k, v in extra.items()})
        return e

    def claude(self, args, cwd, timeout=120, **extra):
        t0 = time.time()
        r = subprocess.run(['claude', *args], cwd=cwd, env=self.env(**extra), capture_output=True, text=True,
                           timeout=timeout)
        return {'code': r.returncode, 'stdout': r.stdout, 'stderr': r.stderr, 'wall_s': round(time.time() - t0, 2)}

    def claude_p(self, prompt, cwd, extra_args=(), **kw):
        args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-hook-events',
                '--permission-mode', 'bypassPermissions', '--model', 'claude-sonnet-4-5', *extra_args]
        r = self.claude(args, cwd, **kw)
        r['events'] = [json.loads(l) for l in r['stdout'].splitlines() if l.startswith('{')]
        return r


def git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


def git_repo(d, files):
    d = Path(d)
    d.mkdir(parents=True, exist_ok=True)
    git(d, 'init', '-q', '-b', 'main')
    for k, v in (('user.email', 'probe@example.test'), ('user.name', 'probe'), ('commit.gpgsign', 'false')):
        git(d, 'config', k, v)
    for rel, text in files.items():
        p = d / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'init')
    return d


def hook_logger(log):
    """A command hook that appends its stdin JSON (+ env bits) as one line to log."""
    script = log.parent / 'log-hook.py'
    script.write_text(
        'import json,os,sys,time\n'
        'd=json.load(sys.stdin)\n'
        'd["_t"]=time.time();d["_pid_cwd"]=os.getcwd()\n'
        'd["_env"]={k:os.environ.get(k) for k in ("CLAUDE_PLUGIN_ROOT","CLAUDE_PLUGIN_DATA","CLAUDE_PROJECT_DIR",'
        '"PROBE_TAG")}\n'
        f'open({str(log)!r},"a").write(json.dumps(d)+"\\n")\n')
    return f'python3 -I {script}'


def read_jsonl(p):
    p = Path(p)
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
