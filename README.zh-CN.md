# h2c-modern

**headers to curl** —— 粘贴一段 HTTP 请求报文，生成对应的 curl 命令行。

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
| `-s, --short`                 | Short options   | `-H` `-A` `-u` `-I` `-X` `-v`                 |
| `-v, --verbose`               | verbose         | 追加 `--verbose`                              |
| `-a, --allow-default-headers` | Default headers | 不抑制 `Accept` / `User-Agent`                |
| `-i, --same-http-version`     | HTTP version    | 追加 `--http1.1` / `--http2`                  |
| `--http`                      | http://         | 默认 https://                                 |
| `--shell <sh\|powershell>`    | sh / PowerShell | 引号方言，默认 sh；powershell 档用 `curl.exe` |

## 转换规则

**总原则**：请求有**明显错误** → 拒绝转换并指出错误；请求**可能有问题** → 照常生成命令， 但以非阻断
warning 提醒（CLI 走 stderr 不影响管道，Web 显示在输出区下方，不参与复制）。

拒绝（明显错误 / 无法忠实表达）：空请求、请求行不是 `METHOD target [HTTP/x]` 两到三段、 method
不是合法 RFC token（tchar，如含分号、括号的注入载荷）、非法 request-target 形态（不以 `/` 开头且非
absolute-form / asterisk-form，如裸 `foo` 或非 CONNECT 的 authority-form； asterisk-form 仅限
`OPTIONS`）、 无冒号的 header 行、header 区含裸 CR（CR 仅可 作为 CRLF 的
组成部分，属请求走私向量）、缺 `Host`（absolute-form 除外）、 多个 `Host`、`Host` 不是合法
authority（含 userinfo `@` / 路径 / 查询 / fragment 字符、端口越界或非数字、IPv6 未 bracket
包裹——这类值拼进 URL 后会被 URL parser 重新解释，造成目标主机混淆）、值不同的重复
`Content-Length`（请求走私特征）、`Transfer-Encoding: chunked`（检查全部同名头的全部 逗号
token，`TE: gzip` + `TE: chunked` 或单条 `TE: gzip, chunked` 同样拒绝）、请求体含二进制/非 UTF-8
字节（U+FFFD 替换字符）、`CONNECT`（代理隧道控制报文）。

生成 + warning（可能有问题）：absolute-form 请求行（直接使用其中 URL；与 `Host` 不一致时
追加提醒）、obs-fold 折叠头（按 RFC 展开）、`OPTIONS *` 的 asterisk-form 请求行（用
`--request-target` 原样发送 target，需 curl ≥ 7.55）、值相同的重复 `Content-Length`（忽略）、
`Content-Length` 与 body 实际字节数不一致（声明大于实际时提示请求体可能被截断；curl 会按实际长度
重算；多出的字节恰好是一段结尾 LF/CRLF 时，warning 会明确提示这很可能只是粘贴文本的末尾换行）、
`Content-Length` 值非数字（curl 自动按 body 计算）、`-i` 遇到未识别的 HTTP 版本（不输出 flag）、URL
含非 ASCII 字符（按 UTF-8 百分号编码）、 Basic 凭据解码后含非 ASCII 字节（超出 `user:password`
常规范围；RFC 7617 未规定编码， 不猜测编码，原样透传 `Authorization` 头）、`Transfer-Encoding` 与
`Content-Length` 同时存在（请求走私特征；curl 会按实际 body 重算 CL 并与 TE 头同时发出）、`GET` /
`HEAD` 带 body（curl 的 `--data-raw` 会把方法切成 POST、 `--head` 与 body 互斥，故追加
`--request GET` / `--request HEAD` 保持方法，部分服务器/代理会拒绝）、 URL 路径/查询含 `{}` /
`[]`（curl 默认把这类字符当 glob 展开：`{a,b}` 会发多个请求、`[abc]` 直接报错；追加 `--globoff`
按字面发送，不做百分号编码，保持 wire format 不变）、PowerShell 方言下参数值含双引号（Windows
PowerShell 5.1 向原生程序传参会破坏此类参数，命令需 PowerShell 7.3+）。

- **方法**：`HEAD` → `--head`；`GET` → 默认；`POST` → `--data-raw`；其它 →
  `--request`（保留原大小写）
- **请求体**：普通 → `--data-raw`（与 `--data-binary` 逐字节等价，但**不解释 curl 的 `@file`
  元语法**——否则 `@` 开头的 body 会被 curl 当本地路径读取并上传，见下文）；声明 `Content-Length: 0`
  的无 body 请求（POST/PUT 等） → `--data-raw ''` 让 curl 实际发送该头 （GET/HEAD
  除外——会改变方法/与 `--head` 冲突，维持不发）；`multipart/form-data` → 同样整体
  `--data-raw`，`Content-Type` 头原样透传（见下文）
- **特殊头**：`User-Agent` → `--user-agent`；`Authorization: Basic` → `--user`； `Accept-Encoding`
  含 gzip/deflate/br/zstd → `--compressed`；`Cookie` 恒走 `-H`（curl 对不含 `=` 的 `--cookie`
  参数按**文件名**解释并尝试读取本地 cookie 文件，是不必要的本地文件读取 与凭据风险）
- **跳过头**：`Host`（用于 URL）、`Content-Length`（curl 自动计算）
- **重复头**：特殊头（`User-Agent` / `Authorization` / `Accept-Encoding`）恰好出现一次时走专属
  选项；**出现重复时全部按原始顺序逐条透传为 `-H`**。重复头本身可能就是请求语义的一部分（安全工具
  常故意构造），且服务端未必按 RFC 把同名头视作等价——逐条透传才能保持 wire format 不变 （`-H` 与
  `-A` 混用会被 curl 抑制，故重复时专属选项完全不用）
- **默认头抑制**：若请求未含 `Accept` / `User-Agent` 且未开启允许默认头，追加 `-H 'Accept:'` /
  `-H 'User-Agent:'` 清空 curl 默认值。同理，`--data-raw` 会触发 curl 注入默认
  `Content-Type: application/x-www-form-urlencoded`：原请求不含 `Content-Type` 时追加
  `-H 'Content-Type:'` 清空
- **curl 配置隔离**：生成的命令以 `--disable`（`-q`）开头，跳过用户本机的 `~/.curlrc`，防止
  本地配置（proxy、header、认证等）改变请求语义，保证命令自包含
- **URL**：`{https|http}://{Host}{path}`；含非 ASCII 字符时按 UTF-8 百分号编码并提醒。 请求行为
  absolute-form 时（`GET http://host/path HTTP/1.1`，完整 URL 写在请求行里， RFC 7230
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

### 二进制请求体会被拒绝

shell 参数无法承载任意字节：非 UTF-8 序列在粘贴/解码阶段已被替换为 U+FFFD， NUL 字节更是无法通过
shell 传递。检测到请求体含 U+FFFD 替换字符时会**拒绝转换** （CLI stderr 退出码 1 / Web
橙色提示），避免静默产出发送错误数据的命令。 可把请求体提取为文件后手动改用 `--data-binary @文件`。

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

## 许可证

MIT
