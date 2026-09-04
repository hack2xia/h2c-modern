# h2c-modern

**headers to curl** —— 粘贴一段 HTTP 请求报文，生成一条在 wire 上尽可能逐字节复现原报文的 curl
命令行；无法忠实表达或明显错误时会显式拒绝或警告。

这是 [curl/h2c](https://github.com/curl/h2c)（原 Perl 脚本）的现代重写版：核心逻辑用 TypeScript
写成纯函数，CLI 与 Web 共享同一份实现，Web 端转换在浏览器本地完成（数据不上传）。

[English README](README.md)

## 技术栈

- **核心**：TypeScript 纯函数（`convert.ts`），无 IO 依赖
- **运行时**：Deno（单二进制，原生 TS，内置 test/fmt/lint/compile）
- **CLI**：`cli.ts`，`deno compile` 编译为独立二进制
- **Web**：单个 `index.html` + `style.css`，`<script type="module">` 导入编译后的核心模块

零 `node_modules`、零构建链，开发循环只有 `deno test`。

## 目录结构

```
h2c-modern/
├── deno.json            # 配置：tasks / lint / fmt
├── convert.ts           # 核心转换逻辑（纯函数）
├── convert_test.ts      # 测试：夹具驱动 + 选项 + 错误用例
├── replay_test.ts       # 回放测试：生成命令真实执行，比对线上字节
├── cli.ts               # CLI 入口
├── index.html           # 前端页面
├── style.css            # 样式
├── testdata/            # 测试夹具（输入 .http / 期望 .curl 成对）
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
├── _build/              # 构建产物（gitignore）
│   ├── convert.mjs      # esbuild 打包生成，供前端 import
│   └── h2c              # deno compile 生成的独立二进制
├── README.md            # 英文文档
└── README.zh-CN.md      # 中文文档
```

## 安装 Deno

需要 **Deno ≥ 2.9.5**（CI 与 Docker 镜像锁定的版本）。

```sh
# macOS
brew install deno
# 或官方脚本
curl -fsSL https://deno.land/install.sh | sh
```

## 开发

```sh
# 跑测试（秒级反馈）
deno task test

# 格式化 / lint
deno task fmt
deno task lint
```

测试是**夹具驱动**的：`testdata/` 里每对 `.http` / `.curl`
文件就是一条用例，测试自动遍历全部比对。新增用例只需丢两个文件，零代码改动。

除夹具比对外还有**回放测试**（`replay_test.ts`）：把每个夹具生成的 curl 命令真实执行到本地
回显服务器（127.0.0.1 随机端口，需本机装有 curl），对比实际收到的字节与原始报文——能抓住
"命令看起来对、线上字节不对"的问题，例如 curl 对 `--data-raw` 自动注入的默认 `Content-Type`。

## 构建

```sh
# 构建前端模块（供 index.html import）
deno task build:web      # -> _build/convert.mjs（通过 esbuild 打包为 ESM）

# 构建 CLI 独立二进制
deno task build:cli      # -> _build/h2c

# 两者一起
deno task build
```

> Deno 2.x 移除了 `deno bundle`，前端模块改用 esbuild（通过 `npm:esbuild` 指定符运行，零
> `node_modules`）。

## 使用

> 输出默认面向 POSIX shell（bash/zsh/sh，引号按 `'\''` 转义）。`--shell powershell` （Web 端为 sh /
> PowerShell 切换）生成 PowerShell 兼容的引号方言：内嵌单引号按 `''` 翻倍转义，程序名输出为
> `curl.exe`——避开 Windows PowerShell 5.1 把裸 `curl` 别名到 Invoke-WebRequest 的问题。cmd
> 不支持（单引号不是引用字符，含 `&` 的 URL 会被拆成 两条命令执行）。
>
> 注意：PowerShell 档需 **PowerShell 7.3+**。Windows PowerShell 5.1 向原生程序传参时不转义参数
> 内嵌的双引号（`PSNativeCommandArgumentPassing` 到 7.3 才默认修复），含 `"` 的参数（如 JSON
> body）会被拆碎。检测到此类参数时会追加 warning 提醒。

### Web

```sh
deno task build:web      # 生成前端模块 _build/convert.mjs
deno task serve          # 启动本地静态服务器（ES module 需通过 http 访问）
```

浏览器打开 http://127.0.0.1:4507 即可。转换在浏览器本地完成，数据不上传。

### CLI

```sh
# 从 stdin
cat request.http | deno run --allow-read cli.ts

# 编译为二进制后
deno task build:cli
./_build/h2c request.http
echo "GET / HTTP/1.1
Host: example.com" | ./_build/h2c

# 选项
./_build/h2c -s -v request.http          # 短选项 + verbose
./_build/h2c -a request.http             # 允许默认请求头
./_build/h2c -i request.http             # 输出 HTTP 版本
./_build/h2c --http request.http         # 使用 http://
```

## 部署（Docker）

```sh
docker build -t h2c-modern .
docker run -d -p 8080:80 --name h2c h2c-modern
```

浏览器打开 `http://localhost:8080`。多阶段构建：builder 阶段用 Deno 打包前端模块，runtime 阶段用
`nginx:alpine` 托管静态文件，最终镜像不含运行时。

CI 会构建镜像并对运行中的容器做冒烟测试——页面、静态资源、以及 `.mjs` 的 MIME 类型 （最后这项正是
`mime.types` 补丁存在的意义；补丁失效只有真实请求一次才能暴露——那时 浏览器会拒绝加载 ES module）。

## 选项

| 选项（CLI）                   | Web             | 说明                                          |
| ----------------------------- | --------------- | --------------------------------------------- |
| `-s, --short`                 | Short options   | `-H` `-I` `-X` `-v` `-g`                      |
| `-v, --verbose`               | verbose         | 追加 `--verbose`                              |
| `-a, --allow-default-headers` | Default headers | 不抑制 `Accept` / `User-Agent`                |
| `-i, --same-http-version`     | HTTP version    | 追加 `--http1.1` / `--http2`                  |
| `--http`                      | http://         | 默认 https://                                 |
| `--shell <sh\|powershell>`    | sh / PowerShell | 引号方言，默认 sh；powershell 档用 `curl.exe` |

## 转换规则

### 行为契约

每个输入恰好落入以下三类之一：

| 类别        | 含义                                | CLI 行为                                     |
| ----------- | ----------------------------------- | -------------------------------------------- |
| **exact**   | 命令在 wire 上逐字节复现原报文      | stdout 输出命令，退出码 0                    |
| **warning** | 命令照常生成，但附带提醒            | stdout 输出命令，warning 走 stderr，退出码 0 |
| **refused** | 无法忠实表达 / 明显错误——不生成命令 | stderr 报错，退出码 1                        |

**拒绝（refused）**：空请求、请求行含前后空白或连续/缺失空格（curl 重建的请求行恒为单空格分隔，
静默折叠会改变线上字节）、请求行不是 `METHOD target [HTTP/x]` 两到三段、 method 不是合法 RFC
token（tchar，如含分号、括号的注入载荷）、非法 request-target 形态（不以 `/` 开头且非 absolute-form
/ asterisk-form，如裸 `foo` 或非 CONNECT 的 authority-form； asterisk-form 仅限
`OPTIONS`）、request-target 含裸 `#` fragment（RFC 7230 禁止 target 携带 fragment，且 curl 会把它
从请求行静默丢弃，`--path-as-is` 也无济于事——转换必然丢字节）、 无冒号的 header 行、header 区含裸
CR（CR 仅可 作为 CRLF 的组成部分，属请求走私向量）、缺 `Host`（absolute-form 除外）、 多个
`Host`、`Host` 不是合法 authority（含 userinfo `@` / 路径 / 查询 / fragment 字符、端口越界或非
数字、IPv6 未 bracket 包裹——这类值拼进 URL 后会被 URL parser 重新解释，造成目标主机混淆）、
值不同的重复 `Content-Length`（请求走私特征）、`Transfer-Encoding: chunked`（检查全部同名头的全部
逗号 token，`TE: gzip` + `TE: chunked` 或单条 `TE: gzip, chunked` 同样拒绝）、输入任意位置含 NUL
字节（shell argv 无法承载 NUL）或二进制/非 UTF-8 字节（U+FFFD 替换字符，请求行 / header / body
任一位置）、`CONNECT`（代理隧道控制报文）。

**生成 + warning（warning）**：混合行尾（部分 CRLF、部分裸 LF——多半在复制/传输中被损坏过，curl
会统一以 CRLF 发送；纯 LF 是从终端/文本工具粘贴的正常形态，**不**提示）、absolute-form 请求行
（直接使用其中 URL；与 `Host` 不一致时追加提醒）、obs-fold 折叠头（按 RFC 展开）、header name
不是合法 RFC 7230 field-name token（原样透传——服务端可能拒绝或整行忽略该头）、header name 含
前后空白（剥离并提醒）、field-value 仅由 OWS 组成（curl 无法复现纯 OWS 的值，退化为空值头发送）、
`OPTIONS *` 的 asterisk-form 请求行（用 `--request-target` 原样发送 target，需 curl ≥ 7.55）、
值相同的重复 `Content-Length`（逐条透传——curl 会逐条发送）、 `Content-Length` 与 body 实际
字节数不一致（声明值原样透传，线上字节与原报文完全一致——包括不一致本身；声明大于实际时提示请求体
可能被截断；多出的字节恰好是一段结尾 LF/CRLF 时，warning 会明确提示这很可能只是粘贴文本的末尾
换行）、`Content-Length` 值非数字（无法透传，curl 自动按 body 计算）、`-i` 遇到未识别的 HTTP 版本
（不输出 flag）、URL 含非 ASCII 字符（按 UTF-8 百分号编码）、`Transfer-Encoding` 与 `Content-Length`
同时存在（请求走私特征；curl 会按实际 body 重算 CL 并与 TE 头同时发出）、`GET` / `HEAD` 带
body（curl 的 `--data-raw` 会把方法切成 POST、 `--head` 与 body 互斥，故追加 `--request GET` /
`--request HEAD` 保持方法，部分服务器/代理会拒绝）、 URL 路径/查询含 `{}` / `[]`（curl
默认把这类字符当 glob 展开：`{a,b}` 会发多个请求、`[abc]` 直接报错；追加 `--globoff`
按字面发送，不做百分号编码，保持 wire format 不变）、PowerShell 方言下参数值含双引号（Windows
PowerShell 5.1 向原生程序传参会破坏此类参数，命令需 PowerShell 7.3+）。

### 请求头处理（wire 实测）

全部原始 header——包括 `Host`、`Content-Length`、`User-Agent`、`Accept-Encoding`、
`Authorization`——**按原始顺序逐条以 `-H` 透传**，不使用任何专属选项（`-A` / `--user` /
`--compressed`）。curl 8.x wire 实测：`-H` 形式的同名头按 argv 位置替换 curl 内部生成的默认头 （Host
/ User-Agent / Accept / Content-Length / Content-Type），不产生重复——因此 `-H`
是唯一能同时保住"头的值、空白形态与原始顺序"的表达方式；专属选项会重排整个 header 块，
且无法控制值的空白。

- `Content-Length` 数值合法时按原位透传（包括与 body 不一致的声明值——线上字节与原报文完全一致，
  包括不一致本身，见 warning 清单）；非数值退回 curl 重算。
- 无 body 且声明 `Content-Length: 0` 的请求，该头经 `-H 'Content-Length: 0'` 发送（实测无 body
  时同样上线）；无 body 的 `POST` 另加 `--request POST` 保持方法（否则 curl 发 GET）。
- `Cookie` 同样恒走 `-H`（curl 对不含 `=` 的 `--cookie` 参数按**文件名**解释并尝试读取本地 cookie
  文件，是不必要的本地文件读取与凭据风险）。
- **默认头抑制**：若请求未含 `Accept` / `User-Agent` 且未开启允许默认头，追加 `-H 'Accept:'` /
  `-H 'User-Agent:'` 清空 curl 默认值。同理，`--data-raw` 会触发 curl 注入默认
  `Content-Type: application/x-www-form-urlencoded`：原请求有 body 但不含 `Content-Type` 时追加
  `-H 'Content-Type:'` 清空。
- **方法**：`HEAD`（无 body）→ `--head`；`GET`（无 body）→ 默认；其它 → `--request`
  （保留原大小写）；`GET`/`HEAD` 带 body 与无 body 的 `POST` → `--request`（见上）。
- **请求体**：普通 → `--data-raw`（与 `--data-binary` 逐字节等价，但**不解释 curl 的 `@file`
  元语法**——否则 `@` 开头的 body 会被 curl 当本地路径读取并上传，见下文）； `multipart/form-data` →
  同样整体 `--data-raw`，`Content-Type` 头原样透传（见下文）。
- **空值 header**：原始报文的空值头（`X-Empty:`）用 curl 的**分号形式** `-H 'X-Empty;'` 发送—— colon
  形式 `-H 'X-Empty:'` 会被 curl 当作"删除该头"，这正是上方合成抑制头所利用的语义。
  分号形式在线上发出 `X-Empty:`（已用真实回放逐字节验证）
- **curl 配置隔离**：生成的命令以 `--disable`（`-q`）开头，跳过用户本机的 `~/.curlrc`，防止
  本地配置（proxy、header、认证等）改变请求语义，保证命令自包含
- **URL**：`{https|http}://{Host}{path}`；含非 ASCII 字符时按 UTF-8 百分号编码并提醒；路径含
  dot-segment（`/./` 或 `/../`）时追加 `--path-as-is` 让 curl 原样发送请求行（curl 默认会按 URL
  标准折叠，如 `/a/../b` → `/b`）。请求行为 absolute-form 时（`GET http://host/path HTTP/1.1`，完整
  URL 写在请求行里， RFC 7230
  规定客户端向代理发请求时必须用这种形态，mitmproxy/Burp/代理日志里粘出来的
  请求常是这样）直接使用其中的 URL

### chunked Transfer-Encoding 会被拒绝

`Transfer-Encoding: chunked` 是**流式语义**——服务端可能依赖分块边界（流式上传、大 body 分批到达），
而 curl 命令行是一次性发送，无法忠实表达这种语义。解码后改用 `--data-raw` 会改变 wire format，
且命令行长度受限（chunked 通常正是因为 body 太大才用）。

因此遇到 chunked 请求会**拒绝转换**：

- **CLI**：输出 `h2c: warning: ...` 到 stderr，退出码 1
- **Web**：在输出区显示橙色 warning（与红色 error 区分）

建议改用 `Content-Length` 形式的请求体后重试。

### 二进制字节会被拒绝

shell 参数无法承载任意字节：非 UTF-8 序列在粘贴/解码阶段已被替换为 U+FFFD， NUL 字节更是无法通过
shell 传递。输入（请求行 / header / body）任一位置含 U+FFFD 替换字符或 NUL 字节时都会**拒绝转换**
（CLI stderr 退出码 1 / Web 橙色提示），避免静默产出发送错误数据的命令。若 body 是二进制，可把它
提取为文件后手动改用 `--data-binary @文件`。

### CONNECT 与 asterisk-form

- `CONNECT` 是代理隧道控制报文，单条 curl 命令无法表达隧道语义，**拒绝转换** （复现流量应使用
  `--proxy` 系列选项）。
- `OPTIONS * HTTP/1.1` 的 asterisk-form 用 `--request-target '*'` 原样发送 target （URL 只承载
  authority），并附 warning（需 curl ≥ 7.55）。asterisk-form 仅对 `OPTIONS` 方法合法，其它方法 带
  `*` target 直接拒绝。

### multipart 整体发送原始 body

`multipart/form-data` 请求**不做任何解析或重构**：请求体经 `--data-raw` 整体字面发送，
`Content-Type` 头（含原始 boundary）按普通头原样透传——线上字节与原报文完全一致，不依赖
本地任何文件。

刻意不使用 `--form` 重构方案，原因有二：

1. `--form` 会让 curl **重新生成 boundary 并重建整个 body**，从未 wire 等价；手写 MIME
   解析在正文恰好包含 boundary 子串、缺失 closing delimiter 等场景下还会静默截断正文、 丢失 part
   头。
2. part 声明的远端 `filename` 会被映射成 `name=@本地路径`——curl 转而**读取并上传本机
   文件**，而不是原始请求体里的字节，构成一条本地文件读取/外传路径。

part 级 `Content-Type`、`Content-Transfer-Encoding`、自定义 part 头等因此全部原样保留。
代价仅是可读性：命令里是完整的原始 body 而非结构化的 `--form` 参数。

请求体含二进制/非 UTF-8 字节（U+FFFD）时依然拒绝转换——把 body 提取为文件后可手动使用
`--data-binary @文件`（`Content-Type` 头照抄原报文即可）。

## 0.4.1 行为变化

本轮以 curl 8.x 的 wire 实测为准收紧了保真度：

- **不再使用专属 header 选项**：输出不再包含 `-A`（`--user-agent`）、`--user`、`--compressed`。
  全部原始 header 按原位以 `-H` 透传——包括此前被跳过的 `Host`（只用于拼 URL）与
  `Content-Length`（交给 curl 重算）。URL 仍由 Host 头拼接。
- **Content-Length 保真而非重算**：数值合法的 CL 按声明值以 `-H` 发送（即使与 body 不一致——线上
  字节与原报文完全一致，并以 warning 指出不一致）；无 body 的 `Content-Length: 0` 经 `-H` 发送； 无
  body 的 `POST` 改用 `--request POST`，不再用 `--data-raw ''` 的旧技巧。
- **请求行校验收紧**：前后空白、连续/缺失空格直接拒绝（此前被静默折叠）；混合行尾（CRLF + 裸 LF）
  产生 warning；纯 LF 输入不提示。
- `Authorization: Basic` 改走 `-H`，不再输出 `--user`。

## 许可证

MIT
