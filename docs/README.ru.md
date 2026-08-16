# codex-proxy-llama.cpp

Универсальный прокси совместимости между OpenAI Codex CLI/IDE и локальным либо удалённым сервером llama.cpp.

## Возможности

- Нативный Responses API без преобразования в Chat Completions.
- Namespaced MCP-инструменты и корректное восстановление их вызовов.
- Нативный `apply_patch` с отображением изменений в специальном diff-интерфейсе Codex.
- Корректный replay истории инструментов и SSE framing.
- Подавление промежуточного «мышления вслух» без потери финального ответа.
- Быстрое сжатие контекста и полные холодные checkpoint-файлы.
- Точный расчёт полезного контекста относительно `n_ctx` llama.cpp.
- Профили Qwen и generic.
- Интерактивная и полностью автоматическая установка без сторонних Python/npm-пакетов.

## Требования

- Node.js 18+.
- Python 3.10+.
- Современный llama.cpp server с `/v1/models` и `/v1/responses`.
- Модель и chat template с качественной поддержкой tool calling.
- Codex CLI либо IDE-расширение Codex с поддержкой пользовательского model provider.

Прокси не может самостоятельно научить обычную модель пользоваться инструментами. Лучше всего подходят модели, обученные агентной разработке и tool calling.

## Быстрый запуск

Сначала запустите llama.cpp:

```bash
llama-server -m /path/to/model.gguf --host 127.0.0.1 --port 8080 --ctx-size 32768
```

Установите прокси:

```bash
git clone https://github.com/madmax24-ubuntu/codex-proxy-llama.cpp.git
cd codex-proxy-llama.cpp
python install.py
```

Установщик опросит `/v1/models`, предложит модель, прочитает `n_ctx`, найдёт свободный порт и создаст изолированный `CODEX_HOME`. По умолчанию это `~/.codex-llama`.

Windows:

```powershell
& "$HOME\.codex-llama\start-proxy.cmd"
```

В другом окне PowerShell:

```powershell
$env:CODEX_HOME = "$HOME\.codex-llama"
codex
```

Linux/macOS:

```bash
~/.codex-llama/start-proxy.sh
```

В другом терминале:

```bash
export CODEX_HOME="$HOME/.codex-llama"
codex
```

Для IDE-расширения задайте `CODEX_HOME` до запуска IDE из этого терминала.

## Автоматическая установка

```bash
python install.py \
  --upstream http://127.0.0.1:8080 \
  --model qwen-model-id \
  --profile qwen \
  --language Russian \
  --codex-home ~/.codex-llama \
  --non-interactive
```

Если сервер пока не запущен:

```bash
python install.py \
  --upstream http://127.0.0.1:8080 \
  --model local-model \
  --context-window 32768 \
  --profile generic \
  --skip-probe \
  --non-interactive
```

`--dry-run` показывает расчёты без записи файлов. `--force` предварительно создаёт резервные копии заменяемых файлов.

## Проверка

```bash
python doctor.py --codex-home ~/.codex-llama --require-proxy
```

Тесты репозитория:

```bash
node proxy.js --selftest
python -m unittest discover -s tests -v
```

## Контекст

Codex применяет `effective_context_window_percent` к размеру из каталога. Установщик выполняет обратный расчёт, чтобы итоговый полезный контекст был точным и не превышал реальный `n_ctx`.

Пример:

```text
llama.cpp n_ctx:      120064
каталог Codex:        126316
процент:                  95
полезный контекст:    120000
```

Порог автосжатия оставляет запас для reasoning и завершения ответа.

## Безопасность

По умолчанию прокси слушает только `127.0.0.1`. Не публикуйте порт в недоверенной сети без TLS и аутентификации. Секрет для защищённого upstream передавайте только через `LLAMA_API_KEY`; установщик не сохраняет его на диск.

По умолчанию каталог объявляет только текстовый ввод. Добавьте `--vision`, если модель и multimodal projector llama.cpp действительно поддерживают изображения. При автоматическом опросе установщик также распознаёт возможности `multimodal` и `vision`, сообщённые сервером.

## Лицензия

MIT
