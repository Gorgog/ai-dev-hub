"""report.py: verdict table of platform probes + before/after check of the global settings.
usage: python3 -I -m unittest discover -s probes/platform -p 'test_*.py'"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPORT = Path(__file__).resolve().parent / 'report.py'
EXPECTED = ['P1', 'P3', 'P5', 'P7', 'P8', 'P16', 'P17']  # P11 снята по решению пользователя (05.11)


def run(*args, home=None):
    env = {'PATH': '/usr/bin:/bin'}
    if home:
        env['HOME'] = str(home)
    return subprocess.run([sys.executable, '-I', str(REPORT), *map(str, args)], capture_output=True, text=True,
                          env=env)


def probe(p, verdict='прошла', numbers=None):
    return {'probe': p, 'verdict': verdict, 'numbers': {'cases': '3/3'} if numbers is None else numbers,
            'criterion': f'criterion {p}', 'claude_version': '2.1.317'}


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.data = self.tmp / 'probes'
        (self.data / 'platform').mkdir(parents=True)
        self.home = self.tmp / 'home'
        (self.home / '.claude' / 'plugins' / 'cache' / 'hub' / 'hub' / 'abc').mkdir(parents=True)
        (self.home / '.claude' / 'settings.json').write_text('{"a": 1}')
        (self.home / '.claude' / 'plugins' / 'installed_plugins.json').write_text('{}')

    def put(self, p, **kw):
        (self.data / 'platform' / f'{p}.json').write_text(json.dumps(probe(p, **kw), ensure_ascii=False))

    def snap(self, name):
        r = run('snapshot', self.data / 'platform' / name, home=self.home)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_all_probes_with_verdicts_and_unchanged_settings_pass(self):
        for p in EXPECTED:
            self.put(p, verdict='не прошла' if p == 'P8' else 'прошла')
        self.snap('global-before.json')
        self.snap('global-after.json')
        r = run(self.data, home=self.home)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for p in EXPECTED:
            self.assertRegex(r.stdout, rf'\| {p} \|')
        self.assertIn('| P8 | не прошла |', r.stdout)
        self.assertIn('cases=3/3', r.stdout)
        self.assertIn('глобальные настройки: без изменений', r.stdout)

    def test_missing_probe_fails_and_is_named(self):
        for p in EXPECTED[1:]:
            self.put(p)
        self.snap('global-before.json')
        self.snap('global-after.json')
        r = run(self.data, home=self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn('нет пробы: P1', r.stdout)

    def test_bad_verdict_or_no_numbers_fails(self):
        for p in EXPECTED:
            self.put(p)
        self.put('P3', verdict='ok')
        self.put('P5', numbers={})
        self.snap('global-before.json')
        self.snap('global-after.json')
        r = run(self.data, home=self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn('P3: вердикт «ok»', r.stdout)
        self.assertIn('P5: нет цифр', r.stdout)

    def test_changed_settings_fail_with_the_file_named(self):
        for p in EXPECTED:
            self.put(p)
        self.snap('global-before.json')
        (self.home / '.claude' / 'settings.json').write_text('{"a": 2}')
        self.snap('global-after.json')
        r = run(self.data, home=self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn('глобальные настройки ИЗМЕНИЛИСЬ: settings.json', r.stdout)

    def test_no_after_snapshot_fails(self):
        for p in EXPECTED:
            self.put(p)
        self.snap('global-before.json')
        r = run(self.data, home=self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn('нет снимка global-after.json', r.stdout)


if __name__ == '__main__':
    unittest.main()
