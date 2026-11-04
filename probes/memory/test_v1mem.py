"""v1mem.records: records of a v1 errors.md.
usage: python3 -I -m unittest discover -s probes/memory -p 'test_*.py'"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

SAMPLE = '''# Правила из ошибок

<!-- Формат: - НЕ делай X.
- это не запись: внутри комментария -->

- НЕ пиши скрипт heredoc-ом: кавычки
  ломаются. (2026-10-01)
- Второе правило. (2026-10-02)\r

## Раздел
- Третье
\tс табом.
  отступ после пустой строки — уже не запись

- Четвёртое
'''


class RecordsTest(unittest.TestCase):
    def test_bullets_with_continuations_are_records(self):
        from v1mem import records
        rs = records(SAMPLE)
        self.assertEqual([r['line'] for r in rs], [6, 8, 11, 15])
        self.assertEqual(rs[0]['text'], 'НЕ пиши скрипт heredoc-ом: кавычки ломаются. (2026-10-01)')
        self.assertEqual(rs[1]['text'], 'Второе правило. (2026-10-02)')
        self.assertEqual(rs[2]['text'], 'Третье с табом.')
        self.assertEqual(rs[3]['text'], 'Четвёртое')

    def test_sha_is_stable_and_differs_by_text(self):
        from v1mem import records
        a, b = records(SAMPLE), records(SAMPLE)
        self.assertEqual([r['sha'] for r in a], [r['sha'] for r in b])
        self.assertEqual(len({r['sha'] for r in a}), 4)
        self.assertRegex(a[0]['sha'], r'^[0-9a-f]{12}$')


if __name__ == '__main__':
    unittest.main()
