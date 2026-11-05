"""report.py: verdict table of the memory probes (slice 07); P6 must carry its time.
usage: python3 -I -m unittest discover -s probes/memory -p 'test_*.py'"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPORT = Path(__file__).resolve().parent / 'report.py'
EXPECTED = ['P2', 'P6', 'P10', 'P13', 'P14', 'P15']


def run(*args):
    return subprocess.run([sys.executable, '-I', str(REPORT), *map(str, args)], capture_output=True, text=True,
                          env={'PATH': '/usr/bin:/bin'})


def probe(p, verdict='прошла', numbers=None):
    if numbers is None:
        numbers = {'cases': '3/3', 'active_min': 41} if p == 'P6' else {'cases': '3/3'}
    return {'probe': p, 'verdict': verdict, 'numbers': numbers, 'criterion': f'criterion {p}', 'path': f'path {p}'}


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.data = Path(tempfile.mkdtemp()) / 'probes'
        (self.data / 'memory').mkdir(parents=True)

    def put(self, p, **kw):
        (self.data / 'memory' / f'{p}.json').write_text(json.dumps(probe(p, **kw), ensure_ascii=False))

    def test_all_probes_with_verdicts_pass(self):
        for p in EXPECTED:
            self.put(p, verdict='не прошла' if p == 'P13' else 'прошла')
        r = run(self.data)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for p in EXPECTED:
            self.assertRegex(r.stdout, rf'\| {p} \|')
        self.assertIn('| P13 | не прошла |', r.stdout)
        self.assertIn('active_min=41', r.stdout)
        self.assertIn('path P13', r.stdout)
        self.assertLess(r.stdout.index('| P2 |'), r.stdout.index('| P10 |'))

    def test_missing_probe_fails_and_is_named(self):
        for p in EXPECTED[1:]:
            self.put(p)
        r = run(self.data)
        self.assertEqual(r.returncode, 1)
        self.assertIn('нет пробы: P2', r.stdout)

    def test_bad_verdict_or_no_numbers_fails(self):
        for p in EXPECTED:
            self.put(p)
        self.put('P14', verdict='ok')
        self.put('P15', numbers={})
        r = run(self.data)
        self.assertEqual(r.returncode, 1)
        self.assertIn('P14: вердикт «ok»', r.stdout)
        self.assertIn('P15: нет цифр', r.stdout)

    def test_p6_without_time_fails(self):
        for p in EXPECTED:
            self.put(p)
        self.put('P6', numbers={'mapped': '18/18'})
        r = run(self.data)
        self.assertEqual(r.returncode, 1)
        self.assertIn('P6: не записано время (active_min)', r.stdout)

    def test_broken_probe_file_is_named_not_a_traceback(self):
        for p in EXPECTED:
            self.put(p)
        for broken in ('{"probe": "P2", ', '[]'):
            (self.data / 'memory' / 'P2.json').write_text(broken)
            r = run(self.data)
            self.assertEqual(r.returncode, 1)
            self.assertIn('P2: файл не читается', r.stdout)
            self.assertNotIn('Traceback', r.stderr)

    def test_no_args_prints_usage(self):
        r = run()
        self.assertEqual(r.returncode, 2)
        self.assertIn('report.py <data>', r.stdout)


if __name__ == '__main__':
    unittest.main()
