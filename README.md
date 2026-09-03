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
injecting a default `Content-Type` for `--data-raw`.

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
| `-s, --short`                 | Short options   | `-H` `-A` `-u` `-I` `-X` `-v`                            |
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
`METHOD target [HTTP/x]` in two or three tokens; a method that isn't a valid RFC token (tchar — e.g.
injection payloads containing semicolons or parentheses); invalid request-target form (not starting
with `/` and not absolute-form / asterisk-form — e.g. bare `foo` or authority-form on a non-CONNECT
method; asterisk-form is only valid for `OPTIONS`); a request-target containing a raw `#` fragment
(RFC 7230 forbids fragments in a target, and curl silently drops them from the request line — even
`--path-as-is` does not help, so this is data loss); header line without a colon; a bare CR inside
the header section (CR is only valid as part of CRLF — a request smuggling vector); missing `Host`
(unless absolute-form); multiple `Host` headers; a `Host` that isn't a valid authority (userinfo
`@`, path/query/fragment characters, out-of-range or non-numeric port, unbracketed IPv6 — such
values would be reinterpreted by the URL parser once concatenated into the URL, causing target host
confusion); duplicate `Content-Length` with different values (an HTTP request smuggling signature);
`Transfer-Encoding: chunked` (all same-name headers and comma tokens are checked — `TE: gzip` +
`TE: chunked` or a single `TE: gzip, chunked` is refused as well); NUL bytes anywhere in the input
(shell arguments cannot carry NUL); binary / non-UTF-8 bytes anywhere in the input (U+FFFD
replacement characters); `CONNECT` (proxy tunnel control message).

Generated + warning (questionable): absolute-form request line (the URL is used directly; an extra
warning is added if it disagrees with the `Host` header); obs-folded headers (unfolded per RFC); a
header name that isn't a valid RFC 7230 field-name token (passed through verbatim — servers may
reject or ignore such a header line); a header value made only of whitespace (curl cannot reproduce
a pure-OWS field value, sent as an empty header); asterisk-form `OPTIONS *` (target sent verbatim
via `--request-target`, requires curl ≥ 7.55); duplicate `Content-Length` with identical values
(ignored); `Content-Length` disagreeing with the actual body byte count (declared > actual suggests
a truncated body — a more explicit hint; curl recomputes from the actual length; when the excess is
exactly a trailing LF/CRLF, the warning calls out the likely paste artifact); non-numeric
`Content-Length` (curl computes from the body); unrecognized HTTP version with `-i` (no version flag
emitted); non-ASCII URL characters (percent-encoded as UTF-8); Basic credentials decoding to
non-ASCII bytes (outside the usual `user:password` range; RFC 7617 doesn't specify an encoding, so
the `Authorization` header is passed through verbatim instead of guessing); `Transfer-Encoding` and
`Content-Length` both present (a request smuggling signature; curl recomputes CL from the actual
body and sends it alongside the TE headers); `GET` / `HEAD` with a body (curl's `--data-raw` would
switch the method to POST, and `--head` conflicts with a body, so `--request GET` / `--request HEAD`
is added to keep the method — some servers/proxies reject such requests); `{}` / `[]` in the URL
path/query (curl treats these as glob metacharacters by default: `{a,b}` sends multiple requests and
`[abc]` errors out; `--globoff` is appended to send them literally, without percent-encoding,
keeping the wire format unchanged); argument values containing double quotes under the PowerShell
dialect (Windows PowerShell 5.1 mangles such arguments when invoking native executables; the command
requires PowerShell 7.3+).

- **Method**: `HEAD` → `--head`; `GET` → default; `POST` → `--data-raw`; others → `--request`
  (original case preserved)
- **Body**: normal → `--data-raw` (byte-for-byte equivalent to `--data-binary`, but **without curl's
  `@file` metasyntax** — otherwise a body starting with `@` would be read from the local filesystem
  and uploaded, see below); a bodyless request that declared `Content-Length: 0` (POST/PUT etc.) →
  `--data-raw ''` so curl actually sends that header (except GET/HEAD — it would change the method /
  conflict with `--head`, so nothing is sent); `multipart/form-data` → also sent as a whole via
  `--data-raw` with the `Content-Type` header passed through verbatim (see below)
- **Special headers**: `User-Agent` → `--user-agent`; `Authorization: Basic` → `--user`;
  `Accept-Encoding` containing gzip/deflate/br/zstd → `--compressed`; `Cookie` always goes through
  `-H` (curl interprets a `--cookie` argument without `=` as a **filename** and tries to read a
  local cookie file — an unnecessary local file read and credential risk)
- **Skipped headers**: `Host` (used for the URL), `Content-Length` (curl computes it)
- **Duplicate headers**: a special header (`User-Agent` / `Authorization` / `Accept-Encoding`) uses
  its dedicated option only when it appears exactly once; **when duplicated, every occurrence is
  passed through as `-H` in original order**. Duplicates may be part of the request semantics
  (security tools deliberately construct them), and servers don't necessarily treat same-name
  headers as equivalent per RFC — passing each line through is the only way to keep the wire format
  unchanged (`-H` suppresses curl-internal headers from `-A`, so dedicated options are not mixed in
  when duplicated)
- **Default header suppression**: if the request lacks `Accept` / `User-Agent` and default headers
  are not allowed, `-H 'Accept:'` / `-H 'User-Agent:'` is appended to clear curl's defaults.
  Likewise, `--data-raw` makes curl inject a default
  `Content-Type: application/x-www-form-urlencoded`: if the original request has no `Content-Type`,
  `-H 'Content-Type:'` is appended to clear it
- **curl config isolation**: the generated command starts with `--disable` (`-q`), which skips the
  user's local `~/.curlrc` so that local config (proxy, headers, auth, ...) cannot change the
  request's semantics — the command stays self-contained
- **URL**: `{https|http}://{Host}{path}`; non-ASCII characters are percent-encoded as UTF-8 with a
  warning; a path containing dot-segments (`/./` or `/../`) gets `--path-as-is` so curl sends the
  request line verbatim instead of squashing them. When the request line is absolute-form
  (`GET
  http://host/path HTTP/1.1` — the full URL written into the request line; RFC 7230 requires
  this form when clients send requests via a proxy, and requests pasted from mitmproxy/Burp/proxy
  logs often look like this), that URL is used directly
- **Empty headers**: an original header with an empty value (`X-Empty:`) is emitted with curl's
  semicolon form `-H 'X-Empty;'` — the colon form `-H 'X-Empty:'` would tell curl to _remove_ the
  header, which is exactly what the synthetic suppression headers (`User-Agent:`, `Accept:`,
  `Content-Type:`) rely on. Wire-verified: `-H 'X-Empty;'` sends `X-Empty:`.

### chunked Transfer-Encoding is refused

`Transfer-Encoding: chunked` is **streaming semantics** — the server may depend on chunk boundaries
(streaming uploads, large bodies arriving in batches), while a curl command line sends everything at
once and cannot express that faithfully. Decoding and switching to `--data-raw` would change the
wire format, and command lines are length-limited (chunked is usually used precisely because the
body is large).

Therefore chunked requests are **refused**:

- **CLI**: `h2c: warning: ...` on stderr, exit code 1
- **Web**: orange warning in the output area (distinct from red errors)

Retry with a `Content-Length` body instead.

### Binary bytes are refused

Shell arguments cannot carry arbitrary bytes: non-UTF-8 sequences have already been replaced by
U+FFFD during pasting/decoding, and NUL bytes cannot pass through a shell at all. When the input
(request line, headers, or body) contains U+FFFD replacement characters or NUL bytes anywhere,
conversion is **refused** (CLI: stderr + exit code 1 / Web: orange notice), instead of silently
producing a command that sends wrong data. If the body is binary, extract it into a file and use
`--data-binary @file` manually.

### CONNECT and asterisk-form

- `CONNECT` is a proxy tunnel control message; a single curl command cannot express tunnel semantics
  — **refused** (reproduce such traffic with the `--proxy` options).
- The asterisk-form `OPTIONS * HTTP/1.1` sends its target verbatim via `--request-target '*'` (the
  URL carries only the authority), with a warning (requires curl ≥ 7.55). asterisk-form is only
  valid for the `OPTIONS` method; any other method with a `*` target is rejected outright.

### multipart body is sent verbatim

`multipart/form-data` requests are **never parsed or reconstructed**: the body is sent as a whole
via `--data-raw` and the `Content-Type` header (including the original boundary) is passed through
verbatim as a normal header — the wire bytes are identical to the original message, with no
dependency on any local file.

Deliberately not using a `--form` reconstruction, for two reasons:

1. `--form` makes curl **regenerate the boundary and rebuild the entire body** — it was never wire
   equivalent. A hand-written MIME parser also silently truncates bodies that happen to contain a
   boundary substring or lack a closing delimiter, and drops part headers.
2. A part's remote `filename` would be mapped to `name=@local-path` — curl would then **read and
   upload a local file** instead of the bytes from the original request body, creating a local file
   read / exfiltration path.

Part-level `Content-Type`, `Content-Transfer-Encoding`, custom part headers, etc. are therefore all
preserved as-is. The only cost is readability: the command contains the full raw body rather than
structured `--form` arguments.

Bodies containing binary / non-UTF-8 bytes (U+FFFD) are still refused — extract the body into a file
and use `--data-binary @file` manually (copy the `Content-Type` header from the original message).

## License

MIT
