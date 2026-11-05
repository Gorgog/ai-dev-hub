// inline-script: скрипт, который shell сам переписывает (двойные кавычки или heredoc без кавычек: обратная кавычка,
// `\\`, `${…}` не параметр shell), — deny с готовой командой «Write в файл, выполнить файл». Скрипт в '…' или
// <<'EOF' доходит как набран — тишина (так сессии правят файлы каждый день). Уроки «heredoc / node -e» проекта A.
'use strict';
const { judge, cases } = require('./H17-protect-files.cjs');

const L = 'уроки «heredoc / node -e» проекта A';
// [id, tool, input, expectDeny, source]
const CORPUS = [
  ['node-e-template', 'Bash', { command: 'node -e "const s = `a${1}`; console.log(s)"' }, true, `${L} (обратные кавычки в node -e "…")`],
  ['node-e-bad-subst', 'Bash', { command: 'node -e "const o = {a: 1}; console.log(\'${o.a}\')"' }, true, `${L} (bad substitution)`],
  ['python-heredoc-unquoted', 'Bash', { command: "python3 - <<EOF\nimport re\nprint(re.sub(r'\\\\d+', '', 'a1'))\nEOF" }, true, `${L} (\\\\ схлопнулся)`],
  ['perl-dq-regex', 'Bash', { command: 'perl -pi -e "s/\\\\s+$//" notes.md' }, true, L],
  ['cat-py-unquoted', 'Bash', { command: 'cat > fix.py <<EOF\nprint("a\\\\n")\nEOF' }, true, `${L} (код в файл heredoc-ом)`],
  ['nested-subst', 'Bash', { command: 'n=$(node -e "console.log(`x`.length)") && echo "$n"' }, true, 'синтетика: внутри $( )'],
  ['python-heredoc-quoted', 'Bash', { command: "python3 - <<'EOF'\nimport re\np='src/a.ts'\ns=open(p).read().replace('\\r\\n', '\\n')\nprint(re.findall(r'\\d+', s))\nEOF" }, false, 'журналы 05.11: так правят файлы ежедневно, тело доходит как набрано'],
  ['perl-single-quoted', 'Bash', { command: "perl -pi -e 's/\\s+$//' notes.md" }, false, "'…' — тело как набрано"],
  ['node-e-plain', 'Bash', { command: 'node -e "console.log(require(\'./package.json\').name)"' }, false, 'без экранирования'],
  ['node-e-shell-var', 'Bash', { command: 'M=<repo>; node -e "console.log(require(\'$M/package.json\'), \\"${HOME}\\")"' }, false, 'журналы 05.11: $M — намеренная подстановка пути'],
  ['commit-heredoc', 'Bash', { command: "git commit -q -m \"$(cat <<'EOF'\nfix: `x` \\\\ ${y}\nEOF\n)\"" }, false, 'сообщение коммита heredoc-ом'],
  ['script-file', 'Bash', { command: 'node scripts/fix.cjs "a\\\\b"' }, false, 'скрипт файлом'],
  ['text-in-echo', 'Bash', { command: "echo 'node -e \"`x`\" — так нельзя' >> notes.md" }, false, 'команда в тексте'],
];

module.exports = {
  id: 'H18', level: 'hook', mech: 'inline-script', title: 'inline-script: экранирование, которое переписывает shell', CORPUS,
  // The deny carries the ready command: Write the body to a file, then the command that runs it (or Write straight
  // into the target file).
  async run(ctx) { return judge('inline-script', cases(CORPUS, 'H18'), ctx, /Write в \S+ .*выполни Bash: `[^`]+`|Write прямо в \S+/); },
};
