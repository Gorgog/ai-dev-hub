"""p06_migrate.py: v1 errors.md records → v2 lessons by a mapping file; deterministic, every theme record addressed.
usage: python3 -I -m unittest discover -s probes/memory -p 'test_*.py'"""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / 'p06_migrate.py'
sys.path.insert(0, str(HERE))

ERRORS = '''# Правила из ошибок

- Скрипт heredoc-ом в Bash: кавычки поехали. Скрипты — файлом через Write. (2026-09-01)
- Снова heredoc: `\\\\` схлопнулся. (2026-09-05)
- `node -e` с бэктиками: шелл выполнил подстановку. (2026-09-07)
- Про Prisma, не по теме. (2026-09-08)
- heredoc на Windows: python-заглушка висит. (2026-09-09)
'''


def shas():
    from v1mem import records
    return [r['sha'] for r in records(ERRORS)]


def mapping(s):
    return {
        'theme': 'heredoc|node -e',
        'lessons': [
            {'id': 'shell-inline-scripts', 'kind': 'rule', 'when': ['PreToolUse:Bash'], 'keys': ['heredoc', 'node -e'],
             'created': '2026-09-01', 'from': [s[0], s[1], s[2]],
             'text': ['Скрипт с кавычками, бэктиками или `\\` — файлом через Write, не heredoc и не `node -e`.',
                      'Шелл Bash-тула выполняет подстановки и схлопывает обратные слэши.']},
        ],
        'archive': [{'sha': s[4], 'reason': 'остаток Windows'}],
    }


def run(errors, mp, out, *extra):
    d = Path(tempfile.mkdtemp())
    (d / 'errors.md').write_text(errors)
    (d / 'mapping.json').write_text(json.dumps(mp, ensure_ascii=False))
    return subprocess.run([sys.executable, '-I', str(SCRIPT), str(d / 'errors.md'), str(d / 'mapping.json'), str(out),
                           *extra], capture_output=True, text=True)


def tree_hash(d):
    h = hashlib.sha256()
    for p in sorted(Path(d).rglob('*')):
        if p.is_file():
            h.update(str(p.relative_to(d)).encode() + b'\0' + p.read_bytes())
    return h.hexdigest()


class MigrateTest(unittest.TestCase):
    def setUp(self):
        self.out = Path(tempfile.mkdtemp())

    def test_lesson_file_has_v2_frontmatter_and_text(self):
        r = run(ERRORS, mapping(shas()), self.out / 'a')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        text = (self.out / 'a' / 'lessons' / 'shell-inline-scripts.md').read_text()
        self.assertEqual(text, '---\nid: shell-inline-scripts\nkind: rule\nwhen: [PreToolUse:Bash]\n'
                               'keys: [heredoc, node -e]\nstatus: active\nsupersedes: []\n'
                               'source: модель (миграция)\ncreated: 2026-09-01\n---\n'
                               'Скрипт с кавычками, бэктиками или `\\` — файлом через Write, не heredoc и не `node -e`.\n'
                               'Шелл Bash-тула выполняет подстановки и схлопывает обратные слэши.\n')

    def test_every_theme_record_gets_an_address(self):
        r = run(ERRORS, mapping(shas()), self.out / 'a')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        addr = json.loads((self.out / 'a' / 'addresses.json').read_text())
        s = shas()
        self.assertEqual(addr[s[0]], [{'line': 3, 'to': 'lesson', 'id': 'shell-inline-scripts', 'merged': 3}])
        self.assertEqual(addr[s[4]], [{'line': 7, 'to': 'archive', 'reason': 'остаток Windows'}])
        self.assertNotIn(s[3], addr)  # not in the theme, not mapped
        self.assertIn('тема: 4/4 записей получили адрес', r.stdout)

    def test_two_runs_are_byte_identical(self):
        run(ERRORS, mapping(shas()), self.out / 'a')
        run(ERRORS, mapping(shas()), self.out / 'b')
        self.assertEqual(tree_hash(self.out / 'a'), tree_hash(self.out / 'b'))

    def test_orphan_theme_record_fails_and_is_named(self):
        mp = mapping(shas())
        mp['archive'] = []
        r = run(ERRORS, mp, self.out / 'a')
        self.assertEqual(r.returncode, 1)
        self.assertIn(f'сирота: строка 7 {shas()[4]}', r.stdout)

    def test_unknown_or_twice_mapped_sha_fails(self):
        mp = mapping(shas())
        mp['archive'].append({'sha': 'deadbeef0000', 'reason': 'x'})
        mp['archive'].append({'sha': shas()[0], 'reason': 'x'})
        r = run(ERRORS, mp, self.out / 'a')
        self.assertEqual(r.returncode, 1)
        self.assertIn('нет в источнике: deadbeef0000', r.stdout)
        self.assertIn(f'дважды: {shas()[0]}', r.stdout)

    def test_record_with_two_rules_is_split_by_parts(self):
        s = shas()
        mp = mapping(s)
        mp['lessons'][0]['from'][2] = {'sha': s[2], 'part': 'node -e и бэктики'}
        mp['lessons'].append({'id': 'shell-substitution', 'kind': 'rule', 'when': ['PreToolUse:Bash'],
                              'keys': ['$('], 'created': '2026-09-07',
                              'from': [{'sha': s[2], 'part': 'подстановка команд'}],
                              'text': ['Бэктики в двойных кавычках Bash — подстановка команд.', 'Проверяй вывод.']})
        r = run(ERRORS, mp, self.out / 'a')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        addr = json.loads((self.out / 'a' / 'addresses.json').read_text())
        self.assertEqual(addr[s[2]], [
            {'line': 5, 'to': 'lesson', 'id': 'shell-inline-scripts', 'merged': 3, 'part': 'node -e и бэктики'},
            {'line': 5, 'to': 'lesson', 'id': 'shell-substitution', 'merged': 1, 'part': 'подстановка команд'}])
        self.assertIn('разбито записей: 1', r.stdout)

    def test_split_needs_a_part_on_every_claim(self):
        s = shas()
        mp = mapping(s)
        mp['archive'].append({'sha': s[2], 'reason': 'x', 'part': 'хвост'})
        r = run(ERRORS, mp, self.out / 'a')
        self.assertEqual(r.returncode, 1)
        self.assertIn(f'дважды: {s[2]}', r.stdout)

    def test_lone_part_same_part_twice_and_empty_lesson_fail(self):
        s = shas()
        mp = mapping(s)
        mp['lessons'][0]['from'][2] = {'sha': s[2], 'part': 'бэктики'}  # split, but its other rule went nowhere
        mp['archive'].append({'sha': s[1], 'reason': 'x', 'part': 'хвост'})
        mp['archive'].append({'sha': s[1], 'reason': 'y', 'part': 'хвост'})
        mp['lessons'][0]['from'].remove(s[1])
        mp['lessons'].append({'id': 'empty', 'kind': 'rule', 'when': [], 'keys': [], 'created': '2026-09-01',
                              'from': [], 'text': ['Пусто.', 'Совсем.']})
        r = run(ERRORS, mp, self.out / 'a')
        self.assertEqual(r.returncode, 1)
        self.assertIn(f'одна часть: {s[2]} — разбитой записи нужны все её части', r.stdout)
        self.assertIn(f'дважды: {s[1]} (часть «хвост»)', r.stdout)
        self.assertIn('empty: урок ни из чего (from пуст)', r.stdout)

    def test_lesson_text_limits(self):
        mp = mapping(shas())
        mp['lessons'][0]['text'] = ['я' * 161]
        r = run(ERRORS, mp, self.out / 'a')
        self.assertEqual(r.returncode, 1)
        self.assertIn('shell-inline-scripts: строк 1, нужно 2–5', r.stdout)
        self.assertIn('shell-inline-scripts: первая строка 161 знаков > 160', r.stdout)

    def test_failed_validation_writes_nothing(self):
        mp = mapping(shas())
        mp['archive'] = []
        run(ERRORS, mp, self.out / 'a')
        self.assertFalse((self.out / 'a').exists())


if __name__ == '__main__':
    unittest.main()
