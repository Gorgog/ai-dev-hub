# Локальные настройки хаба (срез 17)

Часть поведения хаба держат не файлы в git, а настройки машины и проекта. Механизм `setup` (обработчик `setup`,
модуль `plugin/hooks/sessionstart.d/20-setup.cjs`, запись `plugin/mechanisms/setup.json`, полигон H31) на старте
сессии считает, каких не хватает, и пишет одну строку «Хаб: не хватает N настроек (…) — /hub:setup». Скилл
`/hub:setup` (`plugin/skills/setup/`) ставит каждую отдельным вызовом — с подтверждением Claude Code, с бэкапом
`settings.json`. Список настроек и что каждая ставит — `plugin/skills/setup/SKILL.md`; логика —
`plugin/skills/setup/scripts/setup.cjs` (`check [--json]`, `apply <id>`), тесты — `setup.test.cjs` рядом.
`install.cjs` в конце печатает, чего не хватает на машине.

- Модуль молчит, когда всё стоит и после компакции; сломался — пропуск (`onError: open`): настройки — подсказка, не
  защита. Настройку, которую здесь не проверить (нет git у хаба, битый `settings.json`), не считает.
- Версия плагина: установленный `hub@hub` (`installed_plugins.json`) = `main` хаба. Хуки идут из рабочего дерева
  основной копии (P17) и от версии кэша не зависят; кэш несёт скиллы и агентов.
- Автопамять: `autoMemoryDirectory` Claude Code принимает из `.claude/settings.local.json` рабочей копии (из
  проектного `.claude/settings.json` — нет, по безопасности), поэтому настройка — на каждую рабочую копию (`repo/`,
  каждый worktree); файл исключается в `info/exclude`, в git клиента не попадает.

## Строка состояния
`plugin/skills/setup/scripts/statusline.cjs`: `проект · ветка · контекст N% · кэш N% · тяжёлое: <worktree | свободно>`
(и `среднее: …`, когда держат). Контекст — `context_window.used_percentage`, кэш — доля `cache_read` во входе
последнего запроса; держатели — `projects/<имя>/memory/dispatch-grants.json`, истёкший грант — свободно. Ветка — из
файлов `.git`, без процесса git: строка обновляется часто. Чего не прочесть — того нет в строке; ошибкой не падает.

## Allowlist
В `permissions.allow` — только одобренные пользователем записи из `plugin/skills/setup/allowlist.json`. Замер 05.11
(журналы 60 дней): из 592 вызовов, подтверждённых руками, — 465 ответов на AskUserQuestion, 38 одобрений плана, 86
Bash с `git push` (правило `push` = ask намеренно), 3 прочих; обратимых чтений и проверок — 0. Список пуст.

## base-rules.json
Сняты `agent-memory-write` и `agent-memory-shell`: запись в `.claude/agent-memory` запрещает модуль `agent-roles`
(срез 13). `cd-no-subshell` остаётся, пока переменная `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` не стоит и не
проверена вживую: дрейф cwd 05.11 — 872 из 4069 Bash основной сессии (21 %); с переменной (P1) — 0.

## Выкат и откат
R1 (скилл) + R2 (модуль SessionStart, новый файл, имена прежних не меняются). Модуль приходит в стадии `canary`:
включает диспетчер в `projects/<имя>/canary.json` (`"setup"`). Откат — `"stage": "off"` в `plugin/mechanisms/setup.json`
(сразу) или revert мержа; настройки — из бэкапа `settings.json.bak-<время>`.
