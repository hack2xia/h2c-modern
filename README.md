# h2c-modern

**headers to curl** — paste a raw HTTP request message, get the equivalent curl command line.

A modern rewrite of [curl/h2c](https://github.com/curl/h2c) (the original Perl script): the core
logic is a pure TypeScript function shared by the CLI and the Web UI. In the browser, conversion
runs entirely locally — nothing is uploaded.

[中文文档](README.zh-CN.md)

## Tech stack

- **Core**: pure TypeScript function (`convert.ts`), no I/O dependencies
- **Runtime**: Deno (single binary, native TS, built-in test/fmt/lint/compile)
- **CLI**: `cli.ts`, compiled into a standalone binary with `deno compile`
- **Web**: a single `index.html` + `style.css`; `<script type="module">` imports the bundled core
  module

Zero `node_modules`, zero build chain — the dev loop is just `deno test`.

## Project layout

```
h2c-modern/
├── deno.json            # config: tasks / lint / fmt
├── convert.ts           # core conversion logic (pure function)
├── convert_test.ts      # tests: fixture-driven + options + error cases
├── replay_test.ts       # replay tests: run the generated command, compare wire bytes
├── cli.ts               # CLI entry point
├── index.html           # web page
├── style.css            # styles
├── testdata/            # fixtures (paired .http input / .curl expected output)
│   ├── 01_get.*
│   ├── 02_head.*
│   ├── 03_post_json.*
│   ├── 04_put_auth.*
│   ├── 05_cookie_gzip.*
│   ├── 06_multipart.*
│   ├── 07_urlencoded.*
│   ├── 08_bearer.*
│   ├── 09_post_no_ct.*
│   └── 10_multipart_special.*
├── _build/              # build artifacts (gitignored)
│   ├── convert.mjs      # esbuild bundle, imported by the web page
│   └── h2c              # standalone binary from deno compile
├── README.md            # English README
└── README.zh-CN.md      # Chinese README
```

## Installing Deno

```sh
# macOS
brew install deno
# or the official installer script
curl -fsSL https://deno.land/install.sh | sh
```

## Development

```sh
# run tests (seconds of feedback)
deno task test

# format / lint
deno task fmt
deno task lint
```

Tests are **fixture-driven**: every `.http` / `.curl` pair in `testdata/` is a test case; the suite
walks all of them and compares. Adding a case is just dropping two files — zero code changes.

On top of fixture comparison there is a **replay test** (`replay_test.ts`): each fixture's generated
curl command is actually executed against a local echo server (127.0.0.1, random port; requires curl
on the machine), and the bytes received on the wire are compared with the original message. This
catches problems where the command _looks_ right but the wire bytes are wrong — for example curl
injecting a default `Content-Type` for `--data-binary`.

## Build

```sh
# build the web module (imported by index.html)
deno task build:web      # -> _build/convert.mjs (esbuild, bundled as ESM)

# build the standalone CLI binary
deno task build:cli      # -> _build/h2c

# both
deno task build
```

> Deno 2.x removed `deno bundle`, so the web module is built with esbuild (run via the `npm:esbuild`
> specifier — still zero `node_modules`).

## Usage

> Output targets POSIX shells by default (bash/zsh/sh, embedded single quotes escaped as `'\''`).
> `--shell powershell` (a sh / PowerShell toggle on the web) generates the PowerShell quoting
> dialect: embedded single quotes are escaped by doubling (`''`), and the program name becomes
> `curl.exe` — avoiding Windows PowerShell 5.1 aliasing bare `curl` to Invoke-WebRequest. cmd is not
> supported (single quotes are not quoting characters there; a URL containing `&` would be split
> into two commands).
>
> Note: the PowerShell dialect requires **PowerShell 7.3+**. Windows PowerShell 5.1 does not escape
> embedded double quotes when passing arguments to native executables (only fixed by
> `PSNativeCommandArgumentPassing` in 7.3), so arguments containing `"` (e.g. JSON bodies) get
> mangled. When such an argument is detected, a warning is appended.

### Web

```sh
deno task build:web      # build _build/convert.mjs
deno task serve          # local static server (ES modules must be served over http)
```

Open http://127.0.0.1:4507. Conversion happens locally in the browser; nothing is uploaded.

### CLI

```sh
# from stdin
cat request.http | deno run --allow-read cli.ts

# as a compiled binary
deno task build:cli
./_build/h2c request.http
echo "GET / HTTP/1.1
Host: example.com" | ./_build/h2c

# options
./_build/h2c -s -v request.http          # short options + verbose
./_build/h2c -a request.http             # allow curl's default headers
./_build/h2c -i request.http             # emit HTTP version
./_build/h2c --http request.http         # use http://
```

## Deployment (Docker)

```sh
docker build -t h2c-modern .
docker run -d -p 8080:80 --name h2c h2c-modern
```

Open `http://localhost:8080`. Multi-stage build: the builder stage bundles the web module with Deno,
the runtime stage serves the static files with `nginx:alpine`; the final image contains no runtime.

CI builds the image and smoke-tests the running container — page, assets, and the `.mjs` MIME type
(that last one is what the `mime.types` patch exists for; a broken patch only shows up on a real
request, when browsers refuse to load the ES module).

## Options

| CLI option                    | Web             | Description                                              |
| ----------------------------- | --------------- | -------------------------------------------------------- |
| `-s, --short`                 | Short options   | `-H` `-b` `-A` `-u` `-I` `-X` `-v` `-F`                  |
| `-v, --verbose`               | verbose         | append `--verbose`                                       |
| `-a, --allow-default-headers` | Default headers | do not suppress `Accept` / `User-Agent`                  |
| `-i, --same-http-version`     | HTTP version    | append `--http1.1` / `--http2`                           |
| `--http`                      | http://         | default is https://                                      |
| `--shell <sh\|powershell>`    | sh / PowerShell | quoting dialect, default sh; powershell emits `curl.exe` |

## Conversion rules

**Overall principle**: a clearly **broken** request → refuse to convert and report the error; a
**questionable** request → still generate the command, with a non-blocking warning (CLI: warnings go
to stderr and don't affect piping; Web: shown below the output, not part of the copyable text).

Refused (clear errors / impossible to express faithfully): empty request; request line that isn't
`METHOD target [HTTP/x]` in two or three tokens; invalid request-target form (not starting with `/`
and not absolute-form / asterisk-form — e.g. bare `foo` or authority-form on a non-CONNECT method;
asterisk-form is only valid for `OPTIONS`); header line without a colon; a bare CR inside the header
section (CR is only valid as part of CRLF — a request smuggling vector); missing `Host` (unless
absolute-form); multiple `Host` headers; duplicate `Content-Length` with different values (an HTTP
request smuggling signature); `Transfer-Encoding: chunked`; unparseable multipart (missing boundary,
no parts found, a part without Content-Disposition, or a truncated part); body containing binary /
non-UTF-8 bytes (U+FFFD replacement characters); `CONNECT` (proxy tunnel control message).

Generated + warning (questionable): absolute-form request line (the URL is used directly; an extra
warning is added if it disagrees with the `Host` header); obs-folded headers (unfolded per RFC);
asterisk-form `OPTIONS *` (target sent verbatim via `--request-target`, requires curl ≥ 7.55);
duplicate `Content-Length` with identical values (ignored); `Content-Length` disagreeing with the
actual body byte count (declared > actual suggests a truncated body — a more explicit hint; curl
recomputes from the actual length; when the excess is exactly a trailing LF/CRLF, the warning calls
out the likely paste artifact); non-numeric `Content-Length` (curl computes from the body);
unrecognized HTTP version with `-i` (no version flag emitted); non-ASCII URL characters
(percent-encoded as UTF-8); Basic credentials decoding to non-ASCII bytes (outside the usual
`user:password` range; RFC 7617 doesn't specify an encoding, so the `Authorization` header is passed
through verbatim instead of guessing); `GET` / `HEAD` with a body (curl's `--data-binary` would
switch the method to POST, and `--head` conflicts with a body, so `--request GET` / `--request HEAD`
is added to keep the method — some servers/proxies reject such requests); `{}` / `[]` in the URL
path/query (curl treats these as glob metacharacters by default: `{a,b}` sends multiple requests and
`[abc]` errors out; `--globoff` is appended to send them literally, without percent-encoding,
keeping the wire format unchanged); argument values containing double quotes under the PowerShell
dialect (Windows PowerShell 5.1 mangles such arguments when invoking native executables; the command
requires PowerShell 7.3+).

- **Method**: `HEAD` → `--head`; `GET` → default; `POST` → `--data-binary`; others → `--request`
- **Body**: normal → `--data-binary`; a bodyless request that declared `Content-Length: 0` (POST/PUT
  etc.) → `--data-binary ''` so curl actually sends that header (except GET/HEAD — it would change
  the method / conflict with `--head`, so nothing is sent); `multipart/form-data` → parsed into
  multiple `--form`
- **Special headers**: `User-Agent` → `--user-agent`; `Cookie` → `--cookie`; `Authorization: Basic`
  → `--user`; `Accept-Encoding` containing gzip/deflate/br/zstd → `--compressed`
- **Skipped headers**: `Host` (used for the URL), `Content-Length` (curl computes it), multipart
  `Content-Type`
- **Duplicate headers**: a special header (`Cookie` / `User-Agent` / `Authorization` /
  `Accept-Encoding`) uses its dedicated option only when it appears exactly once; **when duplicated,
  every occurrence is passed through as `-H` in original order**. Duplicates may be part of the
  request semantics (security tools deliberately construct them), and servers don't necessarily
  treat same-name headers as equivalent per RFC — passing each line through is the only way to keep
  the wire format unchanged (`-H` suppresses curl-internal headers from `-b` / `-A`, so dedicated
  options are not mixed in when duplicated)
- **Default header suppression**: if the request lacks `Accept` / `User-Agent` and default headers
  are not allowed, `-H 'Accept:'` / `-H 'User-Agent:'` is appended to clear curl's defaults.
  Likewise, `--data-binary` makes curl inject a default
  `Content-Type: application/x-www-form-urlencoded`: if the original request has no `Content-Type`,
  `-H 'Content-Type:'` is appended to clear it
- **URL**: `{https|http}://{Host}{path}`; non-ASCII characters are percent-encoded as UTF-8 with a
  warning. When the request line is absolute-form (`GET http://host/path HTTP/1.1` — the full URL
  written into the request line; RFC 7230 requires this form when clients send requests via a proxy,
  and requests pasted from mitmproxy/Burp/proxy logs often look like this), that URL is used
  directly

### chunked Transfer-Encoding is refused

`Transfer-Encoding: chunked` is **streaming semantics** — the server may depend on chunk boundaries
(streaming uploads, large bodies arriving in batches), while a curl command line sends everything at
once and cannot express that faithfully. Decoding and switching to `--data-binary` would change the
wire format, and command lines are length-limited (chunked is usually used precisely because the
body is large).

Therefore chunked requests are **refused**:

- **CLI**: `h2c: warning: ...` on stderr, exit code 1
- **Web**: orange warning in the output area (distinct from red errors)

Retry with a `Content-Length` body instead.

### Binary bodies are refused

Shell arguments cannot carry arbitrary bytes: non-UTF-8 sequences have already been replaced by
U+FFFD during pasting/decoding, and NUL bytes cannot pass through a shell at all. When the body
contains U+FFFD replacement characters, conversion is **refused** (CLI: stderr + exit code 1 / Web:
orange notice), instead of silently producing a command that sends wrong data. Extract the body into
a file and use `--data-binary @file` manually.

### CONNECT and asterisk-form

- `CONNECT` is a proxy tunnel control message; a single curl command cannot express tunnel semantics
  — **refused** (reproduce such traffic with the `--proxy` options).
- The asterisk-form `OPTIONS * HTTP/1.1` sends its target verbatim via `--request-target '*'` (the
  URL carries only the authority), with a warning (requires curl ≥ 7.55). asterisk-form is only
  valid for the `OPTIONS` method; any other method with a `*` target is rejected outright.

### multipart `--form` behavior

`multipart/form-data` requests are converted into multiple `--form` arguments:

- plain fields → `name=value`; when the value would be misparsed by `--form`'s value syntax,
  `--form-string` is used instead (see below)
- **fields with `filename` → `name=@filename`** (plus `;type=<ct>` when the part declares a
  Content-Type)

`--form`'s value syntax specially interprets a **leading `@` / `<` (read a local file) and embedded
`;type=` / `;filename=` / `;encoder=` / `;headers=` directives**: a field value `@bruce` makes curl
try to read a file named `bruce` (the command just fails), and `hello;filename=x` gets rewritten
into the Content-Disposition — the literal value is silently changed. Such values are therefore sent
with `--form-string` (fully literal, wire-identical; no short option, requires curl ≥ 7.43). The
cost: `--form-string` parses no directives, so a part-level `Content-Type` cannot be attached — when
the two conflict, value fidelity wins, the `;type=` is dropped, and a warning is emitted.

`@filename` is curl syntax: it makes curl **read the content from a local file** instead of sending
the bytes from the original request body. In other words, the generated command depends on a local
file of that name existing. To use the original body content, manually change `@filename` to the
inline form, or use `--data-binary` with the raw body.

This matches the original [curl/h2c](https://github.com/curl/h2c) behavior.

A part-level `Content-Type` is preserved as `;type=` in the generated `--form`; without it curl
guesses by file extension or falls back to `application/octet-stream`, changing the wire format.

If `Content-Type` declares multipart but the `boundary` is missing, no parts can be parsed with the
boundary, a part lacks its Content-Disposition header, or a part looks truncated, h2c **refuses to
convert** (warning + exit code 1 / orange notice on the web) rather than silently producing a
command that loses parts of the body. Check that the original request is complete.

## License

MIT
