// h2c-modern 测试：夹具驱动 + 选项覆盖 + 错误用例
import { assert, assertEquals, assertInstanceOf, assertThrows } from 'jsr:@std/assert@^1.0.19';
import { convert, ConvertWarning } from './convert.ts';

const testdataUrl = new URL('./testdata/', import.meta.url);

function readFixture(name: string, ext: string): string {
  return Deno.readTextFileSync(new URL(`./${name}.${ext}`, testdataUrl));
}

// 夹具驱动：遍历 testdata/*.http，与对应 *.curl 比对（夹具均为正常请求，不应有 warning）
for (const entry of Deno.readDirSync(testdataUrl)) {
  if (!entry.name.endsWith('.http')) continue;
  const name = entry.name.replace(/\.http$/, '');
  Deno.test(`fixture: ${name}`, () => {
    const input = readFixture(name, 'http');
    const expected = readFixture(name, 'curl').trimEnd();
    const result = convert(input);
    assertEquals(result.command.trimEnd(), expected);
    assertEquals(result.warnings, []);
  });
}

// 选项覆盖
Deno.test('option: shortOpt', () => {
  const input = readFixture('02_head', 'http');
  assertEquals(
    convert(input, { shortOpt: true }).command,
    "curl --disable -I -A 'myagent/1.0' -H 'Accept:' -H 'X-Custom: foo' 'https://example.com/document'",
  );
});

Deno.test('option: verbose', () => {
  const input = readFixture('01_get', 'http');
  assertEquals(
    convert(input, { verbose: true }).command,
    "curl --disable --verbose --header 'User-Agent:' --header 'Accept:' 'https://example.com/'",
  );
});

Deno.test('option: allowDefaultHeaders', () => {
  const input = readFixture('01_get', 'http');
  assertEquals(
    convert(input, { allowDefaultHeaders: true }).command,
    "curl --disable 'https://example.com/'",
  );
});

Deno.test('option: sameHttpVersion', () => {
  const input = readFixture('04_put_auth', 'http');
  assertEquals(
    convert(input, { sameHttpVersion: true }).command,
    "curl --disable --http2 --request 'PUT' --user 'alice:secret' --header 'User-Agent:' --header 'Accept:' --header 'Content-Type: application/json' --data-raw '{\"x\":1}' 'https://api.example.com/items/1'",
  );
});

Deno.test('option: useHttp', () => {
  const input = readFixture('01_get', 'http');
  assertEquals(
    convert(input, { useHttp: true }).command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' 'http://example.com/'",
  );
});

// 错误用例
Deno.test('error: missing Host header', () => {
  assertThrows(() => convert('GET / HTTP/1.1\n'), Error, 'missing Host');
});

Deno.test('error: empty request', () => {
  assertThrows(() => convert(''), Error, 'empty request');
});

// chunked：拒绝转换，抛 ConvertWarning（流式语义无法用 curl 命令表达）
Deno.test('chunked: 拒绝转换并抛 ConvertWarning', () => {
  const input = [
    'POST /api HTTP/1.1',
    'Host: api.example.com',
    'Content-Type: text/plain',
    'Transfer-Encoding: chunked',
    '',
    '5',
    'Hello',
    '0',
    '',
  ].join('\r\n');
  try {
    convert(input);
    // 不应到达
    throw new Error('expected ConvertWarning');
  } catch (e) {
    assertInstanceOf(e, ConvertWarning);
    if (!/chunked/i.test(e.message)) {
      throw new Error(`unexpected message: ${e.message}`);
    }
  }
});

// chunked 也接受 LF 行结束符的请求行
Deno.test('chunked: LF 行结束符同样拒绝', () => {
  const input = [
    'POST /api HTTP/1.1',
    'Host: api.example.com',
    'Transfer-Encoding: chunked',
    '',
    '5',
    'Hello',
    '0',
    '',
  ].join('\n');
  assertThrows(() => convert(input), ConvertWarning);
});

// Accept-Encoding: br 也应触发 --compressed
Deno.test('encoding: br 触发 --compressed', () => {
  const input = [
    'GET / HTTP/1.1',
    'Host: example.com',
    'Accept-Encoding: br',
    '',
  ].join('\n');
  assertEquals(
    convert(input).command,
    "curl --disable --compressed --header 'User-Agent:' --header 'Accept:' 'https://example.com/'",
  );
});

// Accept-Encoding: identity（不含已知编码）不应触发 --compressed
Deno.test('encoding: identity 不触发 --compressed', () => {
  const input = [
    'GET / HTTP/1.1',
    'Host: example.com',
    'Accept-Encoding: identity',
    '',
  ].join('\n');
  assertEquals(
    convert(input).command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Accept-Encoding: identity' 'https://example.com/'",
  );
});

// Bearer auth 应作为普通 header 透传
Deno.test('auth: Bearer 透传为 header', () => {
  assertEquals(
    convert('GET / HTTP/1.1\nHost: example.com\nAuthorization: Bearer xyz\n').command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Authorization: Bearer xyz' 'https://example.com/'",
  );
});

// ===== multipart：整体发送原始 body（C3 + H1 修复后的行为）=====
// 不再解析/重构为 --form：curl 会重新生成 boundary（从未 wire 等价），且远端 filename
// 会被映射成本地文件读取。raw body + 原 CT 头透传是逐字节忠实的。

// 远端声明的 filename 必须保持为字面 body 字节，不得变成 name=@本地路径
Deno.test('multipart: filename 不再映射为本地文件读取（C3）', () => {
  const body = [
    '--xyz',
    'Content-Disposition: form-data; name="file"; filename="/etc/passwd"',
    '',
    'benign',
    '--xyz--',
    '',
  ].join('\r\n');
  const input = [
    'POST /upload HTTP/1.1',
    'Host: example.com',
    'Content-Type: multipart/form-data; boundary=xyz',
    '',
    body,
  ].join('\r\n');
  const result = convert(input);
  assertEquals(
    result.command,
    `curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Content-Type: multipart/form-data; boundary=xyz' --data-raw '${body}' 'https://example.com/upload'`,
  );
  assert(!result.command.includes('--form'));
  assertEquals(result.warnings, []);
});

// body 含 boundary 子串不会被截断：原始字节原样保留（旧解析器会静默丢掉 "world"）
Deno.test('multipart: body 含 boundary 子串不截断（H1）', () => {
  const body = [
    '--x',
    'Content-Disposition: form-data; name="a"',
    '',
    'hello--xworld',
    '--x--',
    '',
  ].join('\r\n');
  const input = [
    'POST / HTTP/1.1',
    'Host: example.com',
    'Content-Type: multipart/form-data; boundary=x',
    '',
    body,
  ].join('\r\n');
  const result = convert(input);
  assertEquals(
    result.command,
    `curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Content-Type: multipart/form-data; boundary=x' --data-raw '${body}' 'https://example.com/'`,
  );
  assertEquals(result.warnings, []);
});

// CT 头（含 boundary）按普通头原样透传；缺 boundary 也不再是错误——
// 原始字节本身就是要发送的内容，解析失败不影响忠实度
Deno.test('multipart: CT 头原样透传，缺 boundary 照常发送', () => {
  const input =
    'POST /upload HTTP/1.1\nHost: example.com\nContent-Type: multipart/form-data\n\nraw body';
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Content-Type: multipart/form-data' --data-raw 'raw body' 'https://example.com/upload'",
  );
  assertEquals(result.warnings, []);
});

// 空 body 的 multipart POST 必须保持 POST（旧实现退化为 GET）
Deno.test('multipart: 空 body 的 multipart POST 保持 POST', () => {
  const result = convert(
    'POST / HTTP/1.1\nHost: example.com\nContent-Type: multipart/form-data; boundary=xyz\n',
  );
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Content-Type: multipart/form-data; boundary=xyz' --request POST 'https://example.com/'",
  );
  assertEquals(result.warnings, []);
});

// 值含 @ / < / ;filename= 等文本：raw body 全部字面发送，无需 --form-string 区分
Deno.test('multipart: 值含 @ 与指令文本原样保留', () => {
  const body = [
    '--xyz',
    'Content-Disposition: form-data; name="at"',
    'Content-Type: text/html',
    '',
    '@here',
    '--xyz',
    'Content-Disposition: form-data; name="note"',
    '',
    'hello;filename=x',
    '--xyz--',
  ].join('\n');
  const input = [
    'POST / HTTP/1.1',
    'Host: example.com',
    'Content-Type: multipart/form-data; boundary=xyz',
    '',
    body,
  ].join('\n');
  const result = convert(input);
  assertEquals(
    result.command,
    `curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Content-Type: multipart/form-data; boundary=xyz' --data-raw '${body}' 'https://example.com/'`,
  );
  assertEquals(result.warnings, []);
});

// multipart body 含 U+FFFD（二进制/非 UTF-8 粘贴损伤）同样拒绝
Deno.test('multipart: body 含 U+FFFD 拒绝转换', () => {
  const body = ['--xyz', 'Content-Disposition: form-data; name="f"', '', 'ab\uFFFDefg', '--xyz--']
    .join(
      '\r\n',
    );
  const input = [
    'POST /upload HTTP/1.1',
    'Host: example.com',
    'Content-Type: multipart/form-data; boundary=xyz',
    '',
    body,
  ].join('\r\n');
  assertThrows(() => convert(input), ConvertWarning, 'U+FFFD');
});

// 重复 Cookie 头：逐条透传为 -H，保持 wire format（安全工具常故意构造重复头，
// 合并为 "; " 会改变线上字节；且 -H 'Cookie:' 会抑制 -b，不能混用）
Deno.test('dup headers: 多个 Cookie 逐条透传', () => {
  const input = [
    'GET / HTTP/1.1',
    'Host: example.com',
    'Cookie: a=1',
    'Cookie: b=2',
    '',
  ].join('\n');
  assertEquals(
    convert(input).command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Cookie: a=1' --header 'Cookie: b=2' 'https://example.com/'",
  );
});

// 单个 Cookie 也走 -H：curl 对不含 = 的 --cookie 参数按文件名解释（读取本地
// cookie 文件），是意外的本地文件读取与凭据风险，统一 header 形式
Deno.test('dup headers: 单个 Cookie 用 -H 透传', () => {
  const input = ['GET / HTTP/1.1', 'Host: example.com', 'Cookie: a=1', ''].join('\n');
  assertEquals(
    convert(input).command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Cookie: a=1' 'https://example.com/'",
  );
});

// 不含 = 的 Cookie 也必须按字面 header 发送：--cookie 会把它当文件名读本地文件
Deno.test('dup headers: 无 = 的 Cookie 不触发本地文件读取', () => {
  const input = [
    'GET / HTTP/1.1',
    'Host: example.com',
    'Cookie: /home/user/.curl-cookies',
    '',
  ].join('\n');
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Cookie: /home/user/.curl-cookies' 'https://example.com/'",
  );
  assertEquals(result.warnings, []);
});

// 重复 User-Agent：全部透传为 -H（混用 -A 与 -H 会被 curl 抑制掉 -A）
Deno.test('dup headers: 重复 User-Agent 全部透传', () => {
  const input = [
    'GET / HTTP/1.1',
    'Host: example.com',
    'User-Agent: first/1.0',
    'User-Agent: second/2.0',
    '',
  ].join('\n');
  assertEquals(
    convert(input).command,
    "curl --disable --header 'Accept:' --header 'User-Agent: first/1.0' --header 'User-Agent: second/2.0' 'https://example.com/'",
  );
});

// ===== 总原则：明显错误拒绝；可能有问题则生成 + warning =====

// 明显错误：请求行超过三段（多半是 URL 含未编码空格，截断会丢数据）
Deno.test('error: 请求行超过三段拒绝', () => {
  assertThrows(
    () => convert('GET /hello world HTTP/1.1\nHost: example.com\n'),
    Error,
    'invalid request line',
  );
});

// 明显错误：无冒号的 header 行（此前静默跳过会丢数据）
Deno.test('error: 无冒号 header 行拒绝', () => {
  assertThrows(
    () => convert('GET / HTTP/1.1\nHost: example.com\ngarbage line\n'),
    Error,
    'invalid header line',
  );
});

// 明显错误：多个 Host 头（RFC 7230 要求必须拒绝）
Deno.test('error: 多个 Host 头拒绝', () => {
  assertThrows(
    () => convert('GET / HTTP/1.1\nHost: a.com\nHost: b.com\n'),
    Error,
    'multiple Host',
  );
});

// 明显错误：值不同的重复 Content-Length（请求走私特征，无法忠实表达）
Deno.test('error: 值不同的重复 Content-Length 拒绝', () => {
  const input = [
    'POST / HTTP/1.1',
    'Host: example.com',
    'Content-Length: 6',
    'Content-Length: 5',
    '',
    'hello',
  ].join('\r\n');
  assertThrows(() => convert(input), ConvertWarning, 'Content-Length');
});

// 可能有问题：absolute-form 请求行 → 直接使用其中 URL + warning
Deno.test('warn: absolute-form 请求行', () => {
  const input = 'GET http://example.com/x HTTP/1.1\nHost: example.com\n';
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' 'http://example.com/x'",
  );
  assertEquals(result.warnings.length, 1);
  if (!/absolute-form/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

// 可能有问题：absolute-form 与 Host 头不一致 → 追加提醒
Deno.test('warn: absolute-form 与 Host 不一致', () => {
  const input = 'GET http://a.com/x HTTP/1.1\nHost: b.com\n';
  const result = convert(input);
  assertEquals(result.warnings.length, 2);
  if (!/does not match/.test(result.warnings[1])) {
    throw new Error(`unexpected warning: ${result.warnings[1]}`);
  }
});

// 可能有问题：absolute-form 缺 Host 头也可转换（URL 自包含）
Deno.test('warn: absolute-form 无需 Host 头', () => {
  const result = convert('GET http://example.com/ HTTP/1.1\n');
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' 'http://example.com/'",
  );
});

// 可能有问题：obs-fold 折叠头 → 展开合并 + warning
Deno.test('warn: obs-fold 折叠头展开', () => {
  const input = 'GET / HTTP/1.1\nHost: example.com\nX-Long: part1\n  part2\n';
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'X-Long: part1 part2' 'https://example.com/'",
  );
  assertEquals(result.warnings.length, 1);
});

// 可能有问题：值相同的重复 Content-Length → 忽略 + warning
Deno.test('warn: 值相同的重复 Content-Length', () => {
  const input = [
    'POST / HTTP/1.1',
    'Host: example.com',
    'Content-Length: 5',
    'Content-Length: 5',
    '',
    'hello',
  ].join('\r\n');
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Content-Type:' --data-raw 'hello' 'https://example.com/'",
  );
  assertEquals(result.warnings.length, 1);
});

// 可能有问题：-i 遇到未识别的 HTTP 版本 → 不输出 flag + warning
Deno.test('warn: 未识别的 HTTP 版本', () => {
  const result = convert('GET / HTTP/3\nHost: example.com\n', { sameHttpVersion: true });
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' 'https://example.com/'",
  );
  assertEquals(result.warnings.length, 1);
});

// 可能有问题：Basic 凭据解码后含非 ASCII 字节 → 不猜编码，原样透传 + warning
Deno.test('warn: 非 ASCII Basic 凭据原样透传', () => {
  // 'alice:密码' 的 UTF-8 base64
  const encoded = btoa(
    String.fromCharCode(...new TextEncoder().encode('alice:密码')),
  );
  const result = convert(`GET / HTTP/1.1\nHost: example.com\nAuthorization: Basic ${encoded}\n`);
  assertEquals(
    result.command,
    `curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Authorization: Basic ${encoded}' 'https://example.com/'`,
  );
  assertEquals(result.warnings.length, 1);
});

// 纯 ASCII 的 Basic 凭据仍转 --user
Deno.test('auth: ASCII Basic 转 --user', () => {
  const encoded = btoa('alice:secret');
  const result = convert(`GET / HTTP/1.1\nHost: example.com\nAuthorization: Basic ${encoded}\n`);
  assertEquals(
    result.command,
    "curl --disable --user 'alice:secret' --header 'User-Agent:' --header 'Accept:' 'https://example.com/'",
  );
  assertEquals(result.warnings, []);
});

// 可能有问题：URL 含非 ASCII 字符 → UTF-8 百分号编码 + warning
Deno.test('warn: URL 非 ASCII 编码', () => {
  const result = convert('GET /搜索?q=x HTTP/1.1\nHost: example.com\n');
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' 'https://example.com/%E6%90%9C%E7%B4%A2?q=x'",
  );
  assertEquals(result.warnings, ['URL contains non-ASCII characters; percent-encoded as UTF-8']);
});

// 已编码的 URL 不应被二次编码
Deno.test('url: 已百分号编码的 URL 原样保留', () => {
  const result = convert('GET /%E6%90%9C?q=x%20y HTTP/1.1\nHost: example.com\n');
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' 'https://example.com/%E6%90%9C?q=x%20y'",
  );
  assertEquals(result.warnings, []);
});

// ===== HTTP/2 伪头检测：拒绝转换（h2c 仅处理 HTTP/1.x） =====
Deno.test('error: HTTP/2 伪头拒绝转换', () => {
  const input = [
    'GET / HTTP/2',
    'Host: example.com',
    ':method: GET',
    ':path: /',
    ':authority: example.com',
    '',
  ].join('\n');
  assertThrows(() => convert(input), Error, 'HTTP/2 pseudo-header');
});

// 单个伪头也要拒绝（防止静默当成普通头解析）
Deno.test('error: 单个 HTTP/2 伪头也拒绝', () => {
  const input = 'GET / HTTP/1.1\nHost: example.com\n:authority: example.com\n';
  assertThrows(() => convert(input), Error, 'HTTP/2 pseudo-header');
});

// ===== request-target 形态校验（RFC 7230 §5.3）：非四种合法形态拒绝 =====

// 裸 target（非 / 开头、非 absolute/asterisk 形态）：静默拼接会产出 host/path 粘连的垃圾 URL
Deno.test('error: 非 origin-form/absolute-form/asterisk-form 的 target 拒绝', () => {
  assertThrows(
    () => convert('GET foo HTTP/1.1\nHost: example.com\n'),
    Error,
    'invalid request-target',
  );
});

// authority-form 仅限 CONNECT：GET 带 authority-form 同样拒绝
Deno.test('error: 非 CONNECT 的 authority-form target 拒绝', () => {
  assertThrows(
    () => convert('GET example.com:8080 HTTP/1.1\nHost: example.com\n'),
    Error,
    'invalid request-target',
  );
});

// asterisk-form 仅限 OPTIONS
Deno.test('error: asterisk-form 仅限 OPTIONS', () => {
  assertThrows(
    () => convert('GET * HTTP/1.1\nHost: example.com\n'),
    Error,
    'asterisk-form',
  );
});

// ===== POST 无 body：不再注入 --data-raw ''，改用 --request POST =====
Deno.test('post: 无 body 用 --request POST 不注入 Content-Length', () => {
  const result = convert('POST /api HTTP/1.1\nHost: example.com\n');
  // 注：--request POST 追加在 -H 之后、URL 之前；顺序不影响 curl 行为
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --request POST 'https://example.com/api'",
  );
  assertEquals(result.warnings, []);
});

// POST 无 body 的短选项形态
Deno.test('post: 无 body 短选项 -X POST', () => {
  const result = convert('POST /api HTTP/1.1\nHost: example.com\n', { shortOpt: true });
  assertEquals(
    result.command,
    "curl --disable -H 'User-Agent:' -H 'Accept:' -X POST 'https://example.com/api'",
  );
});

// POST 有 body 仍走 --data-raw（自动触发 POST，不追加 --request）
Deno.test('post: 有 body 不追加 --request', () => {
  const input = [
    'POST /api HTTP/1.1',
    'Host: example.com',
    'Content-Length: 5',
    '',
    'hello',
  ].join('\r\n');
  assertEquals(
    convert(input).command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Content-Type:' --data-raw 'hello' 'https://example.com/api'",
  );
});

// ===== 非标准 OWS：特殊头退化到 -H 透传 + warning =====

// User-Agent 含前导多空格：退化到 -H
Deno.test('ows: User-Agent 多空格退化到 -H', () => {
  const input = 'GET / HTTP/1.1\nHost: example.com\nUser-Agent:  spaced/1.0\n';
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --header 'Accept:' --header 'User-Agent:  spaced/1.0' 'https://example.com/'",
  );
  assertEquals(result.warnings.length, 1);
  if (!/User-Agent.*non-standard OWS/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

// User-Agent 含后导空格：退化到 -H
Deno.test('ows: User-Agent 后导空格退化到 -H', () => {
  const input = 'GET / HTTP/1.1\nHost: example.com\nUser-Agent: trailing/1.0 \n';
  const result = convert(input);
  // 后导空格在 shQuote 内会被原样保留，curl 发送时含后导空格
  assertEquals(
    result.command,
    "curl --disable --header 'Accept:' --header 'User-Agent: trailing/1.0 ' 'https://example.com/'",
  );
  assertEquals(result.warnings.length, 1);
});

// User-Agent 含 HTAB：退化到 -H
Deno.test('ows: User-Agent HTAB 退化到 -H', () => {
  const input = 'GET / HTTP/1.1\nHost: example.com\nUser-Agent:\ttabbed/1.0\n';
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --header 'Accept:' --header 'User-Agent:\ttabbed/1.0' 'https://example.com/'",
  );
  assertEquals(result.warnings.length, 1);
});

// Cookie 含非标准 OWS：恒走 -H（无专属选项，也不再有 OWS 退化 warning）
Deno.test('ows: Cookie 多空格原样透传', () => {
  const input = 'GET / HTTP/1.1\nHost: example.com\nCookie:  a=1\n';
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Cookie:  a=1' 'https://example.com/'",
  );
  assertEquals(result.warnings, []);
});

// Authorization 含非标准 OWS：退化到 -H
Deno.test('ows: Authorization HTAB 退化到 -H', () => {
  const input = 'GET / HTTP/1.1\nHost: example.com\nAuthorization:\tBasic abc\n';
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Authorization:\tBasic abc' 'https://example.com/'",
  );
  assertEquals(result.warnings.length, 1);
});

// 标准 OWS（1 个前导 SP）仍走专属选项，无 warning
Deno.test('ows: 标准 1 SP 仍用专属选项', () => {
  const input = 'GET / HTTP/1.1\nHost: example.com\nUser-Agent: normal/1.0\n';
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --user-agent 'normal/1.0' --header 'Accept:' 'https://example.com/'",
  );
  assertEquals(result.warnings, []);
});

// 无前导 OWS（Name:value 紧挨）也走专属选项
Deno.test('ows: 无前导 OWS 也走专属选项', () => {
  const input = 'GET / HTTP/1.1\nHost:example.com\nUser-Agent:normal/1.0\n';
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --user-agent 'normal/1.0' --header 'Accept:' 'https://example.com/'",
  );
  assertEquals(result.warnings, []);
});

// 普通 -H 透传：标准 1 SP 输出形态保持原样
Deno.test('ows: 普通 header 标准 SP 形态', () => {
  const input = 'GET / HTTP/1.1\nHost: example.com\nX-Custom: foo\n';
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'X-Custom: foo' 'https://example.com/'",
  );
  assertEquals(result.warnings, []);
});

// 普通 -H 透传：无前导 SP（Name:value）保持原样
Deno.test('ows: 普通 header 无前导 SP 形态', () => {
  const input = 'GET / HTTP/1.1\nHost: example.com\nX-Custom:foo\n';
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'X-Custom:foo' 'https://example.com/'",
  );
  assertEquals(result.warnings, []);
});

// 普通 -H 透传：多空格保持原样（不剥离）
Deno.test('ows: 普通 header 多空格保持原样', () => {
  const input = 'GET / HTTP/1.1\nHost: example.com\nX-Custom:  foo\n';
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'X-Custom:  foo' 'https://example.com/'",
  );
  assertEquals(result.warnings, []);
});

// Host 头含非标准 OWS：URL 中剥离 + warning
Deno.test('ows: Host 含非标准 OWS 剥离 + warning', () => {
  const input = 'GET / HTTP/1.1\nHost:\texample.com\n';
  const result = convert(input);
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' 'https://example.com/'",
  );
  assertEquals(result.warnings.length, 1);
  if (!/Host.*non-standard OWS/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

// header name 含前后空白：警告 + 剥离
// 注意：行首为空白会被 obs-fold 当续行处理，故只测 name 含后导空格的情况
Deno.test('ows: header name 含后导空格警告', () => {
  const input = 'GET / HTTP/1.1\nHost: example.com\nX-Custom : foo\n';
  const result = convert(input);
  // name "X-Custom " 含后导空格，已剥离；value 含标准前导 SP
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'X-Custom: foo' 'https://example.com/'",
  );
  assertEquals(result.warnings.length, 1);
  if (!/header name.*whitespace/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

// ===== GET / HEAD 带 body：--data-raw 会把方法切成 POST，必须显式 --request 保持方法 =====

Deno.test('get: 带 body 用 --request GET 保持方法 + warning', () => {
  const result = convert('GET /search HTTP/1.1\nHost: example.com\n\nquery=1');
  assertEquals(
    result.command,
    "curl --disable --request GET --header 'User-Agent:' --header 'Accept:' --header 'Content-Type:' --data-raw 'query=1' 'https://example.com/search'",
  );
  assertEquals(result.warnings.length, 1);
  if (!/GET.*body/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

Deno.test('get: 带 body 短选项 -X GET', () => {
  const result = convert('GET /search HTTP/1.1\nHost: example.com\n\nx', { shortOpt: true });
  assertEquals(
    result.command,
    "curl --disable -X GET -H 'User-Agent:' -H 'Accept:' -H 'Content-Type:' --data-raw 'x' 'https://example.com/search'",
  );
  assertEquals(result.warnings.length, 1);
});

// HEAD + body：--head 与 --data-raw 互斥（curl 报错），改用 --request HEAD
Deno.test('head: 带 body 用 --request HEAD + warning', () => {
  const result = convert('HEAD /x HTTP/1.1\nHost: example.com\n\nhello');
  assertEquals(
    result.command,
    "curl --disable --request HEAD --header 'User-Agent:' --header 'Accept:' --header 'Content-Type:' --data-raw 'hello' 'https://example.com/x'",
  );
  assertEquals(result.warnings.length, 1);
  if (!/HEAD.*body/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

Deno.test('head: 无 body 仍用 --head', () => {
  const result = convert('HEAD /x HTTP/1.1\nHost: example.com\n');
  assertEquals(
    result.command,
    "curl --disable --head --header 'User-Agent:' --header 'Accept:' 'https://example.com/x'",
  );
  assertEquals(result.warnings, []);
});

// ===== curl glob 元字符：{} / [] 会触发 glob 展开或直接报错，追加 --globoff 按字面发送 =====

Deno.test('url: 路径含 {} 追加 --globoff + warning', () => {
  const result = convert('GET /{a,b} HTTP/1.1\nHost: example.com\n');
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --globoff 'https://example.com/{a,b}'",
  );
  assertEquals(result.warnings.length, 1);
  if (!/globoff/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

Deno.test('url: 查询参数含 [] 短选项 -g', () => {
  const result = convert('GET /search?a[0]=1 HTTP/1.1\nHost: example.com\n', { shortOpt: true });
  assertEquals(
    result.command,
    "curl --disable -H 'User-Agent:' -H 'Accept:' -g 'https://example.com/search?a[0]=1'",
  );
  assertEquals(result.warnings.length, 1);
});

Deno.test('url: IPv6 主机括号不触发 globoff', () => {
  const result = convert('GET /x HTTP/1.1\nHost: [::1]:8080\n');
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' 'https://[::1]:8080/x'",
  );
  assertEquals(result.warnings, []);
});

Deno.test('url: absolute-form 含 {} 同样追加 --globoff', () => {
  const result = convert('GET http://example.com/{a,b} HTTP/1.1\n');
  // absolute-form + globoff 两条 warning
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --globoff 'http://example.com/{a,b}'",
  );
  assertEquals(result.warnings.length, 2);
});

// ===== Content-Length 与 body 实际字节数：curl 会重算，不一致应提醒 =====

Deno.test('warn: Content-Length 大于 body 字节数（可能截断）', () => {
  const result = convert(
    'POST /api HTTP/1.1\nHost: example.com\nContent-Length: 100\n\nhello world',
  );
  assertEquals(result.warnings.length, 1);
  if (!/Content-Length/.test(result.warnings[0]) || !/truncated/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

Deno.test('warn: Content-Length 小于 body 字节数', () => {
  const result = convert(
    'POST /api HTTP/1.1\nHost: example.com\nContent-Length: 5\n\nhello world',
  );
  assertEquals(result.warnings.length, 1);
  if (!/Content-Length/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

// 多出的字节恰好是一段结尾换行：大概率是粘贴文本的末尾换行，专门提示
Deno.test('warn: 结尾 LF 恰好抵消 CL 差值时提示粘贴换行', () => {
  const result = convert(
    'POST /api HTTP/1.1\nHost: example.com\nContent-Length: 5\n\nhello\n',
  );
  assertEquals(result.warnings.length, 1);
  if (!/trailing LF/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

Deno.test('warn: 结尾 CRLF 恰好抵消 CL 差值时提示粘贴换行', () => {
  const result = convert(
    'POST /api HTTP/1.1\r\nHost: example.com\r\nContent-Length: 5\r\n\r\nhello\r\n',
  );
  assertEquals(result.warnings.length, 1);
  if (!/trailing CRLF/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

// 多出的字节不是换行形态：维持通用不一致提示
Deno.test('warn: 多出字节非换行时维持通用提示', () => {
  const result = convert(
    'POST /api HTTP/1.1\nHost: example.com\nContent-Length: 5\n\nhello!!',
  );
  assertEquals(result.warnings.length, 1);
  if (!/inconsistent/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

// ===== 裸 CR（非 CRLF 组成部分）：拒绝，不生成含不可见 CR 的命令 =====

Deno.test('error: header 行含裸 CR 拒绝', () => {
  assertThrows(
    () => convert('GET / HTTP/1.1\nHost: h\rX-A: v\n'),
    Error,
    'bare CR',
  );
});

// 请求行里的裸 CR 若与空格相邻会被 split(/\s+/) 静默吞掉（path 被改变），也要拒绝
Deno.test('error: 请求行含裸 CR 拒绝', () => {
  assertThrows(
    () => convert('GET /a \r HTTP/1.1\nHost: h\n'),
    Error,
    'bare CR',
  );
});

Deno.test('ok: Content-Length 与 body 字节数一致无 warning', () => {
  const result = convert(
    'POST /api HTTP/1.1\nHost: example.com\nContent-Length: 11\n\nhello world',
  );
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Content-Type:' --data-raw 'hello world' 'https://example.com/api'",
  );
  assertEquals(result.warnings, []);
});

Deno.test('ok: 无 body 且 Content-Length: 0 无 warning', () => {
  const result = convert('POST /api HTTP/1.1\nHost: example.com\nContent-Length: 0\n');
  // 原始声明 CL:0：--data-raw '' 让 curl 实际发送 Content-Length: 0（默认一个头都不发）
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Content-Type:' --data-raw '' 'https://example.com/api'",
  );
  assertEquals(result.warnings, []);
});

// 按 UTF-8 字节数比较：h + é(2B) + llo = 6 字节
Deno.test('warn: 多字节字符按字节数计算（héllo 为 6 字节）', () => {
  const result = convert(
    'POST /api HTTP/1.1\nHost: example.com\nContent-Length: 5\n\nh\u00e9llo',
  );
  assertEquals(result.warnings.length, 1);
});

Deno.test('warn: Content-Length 非数字值', () => {
  const result = convert(
    'POST /api HTTP/1.1\nHost: example.com\nContent-Length: abc\n\nhello',
  );
  assertEquals(result.warnings.length, 1);
  if (!/Content-Length/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

// ===== Content-Type 默认值抑制：--data-raw 会让 curl 注入
// application/x-www-form-urlencoded，原请求无 CT 时必须 -H 'Content-Type:' 清空 =====

// 夹具 09_post_no_ct 覆盖无 CT 的标准形态；这里对照验证已有 CT 时不抑制
Deno.test('ct: 已有 Content-Type 不追加抑制', () => {
  const result = convert('POST /a HTTP/1.1\nHost: e.com\nContent-Type: text/plain\n\nhi');
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Content-Type: text/plain' --data-raw 'hi' 'https://e.com/a'",
  );
  assertEquals(result.warnings, []);
});

// ===== CL:0 保真：声明 Content-Length: 0 的无 body 请求要让 curl 真的发这个头 =====

Deno.test('cl0: PUT 带 Content-Length: 0 用 --data-raw 保留空 body', () => {
  const result = convert('PUT /a HTTP/1.1\nHost: example.com\nContent-Length: 0\n');
  assertEquals(
    result.command,
    "curl --disable --request 'PUT' --header 'User-Agent:' --header 'Accept:' --header 'Content-Type:' --data-raw '' 'https://example.com/a'",
  );
  assertEquals(result.warnings, []);
});

Deno.test('cl0: GET 带 Content-Length: 0 不注入空 body（--data-raw 会切 POST）', () => {
  const result = convert('GET /a HTTP/1.1\nHost: example.com\nContent-Length: 0\n');
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' 'https://example.com/a'",
  );
  assertEquals(result.warnings, []);
});

Deno.test('post: 无 body 且未声明 CL 时仍用 --request POST 不注入', () => {
  const result = convert('POST /api HTTP/1.1\nHost: example.com\n');
  if (/--data-raw/.test(result.command)) {
    throw new Error(`原始请求没有声明 CL，不应注入空 body: ${result.command}`);
  }
});

// ===== 二进制 body：U+FFFD 替换字符 → 拒绝转换（shell 无法承载任意字节） =====

Deno.test('binary: 请求体含 U+FFFD 拒绝转换', () => {
  const input = 'POST /up HTTP/1.1\nHost: example.com\nContent-Length: 6\n\nab\uFFFDefg';
  assertThrows(() => convert(input), ConvertWarning, 'U+FFFD');
});

// ===== CONNECT：代理隧道控制报文，无法表达 =====

Deno.test('error: CONNECT 拒绝转换', () => {
  assertThrows(
    () => convert('CONNECT example.com:443 HTTP/1.1\nHost: example.com:443\n'),
    ConvertWarning,
    'CONNECT',
  );
});

// ===== asterisk-form：OPTIONS * → --request-target 原样发送 =====

Deno.test('warn: asterisk-form 用 --request-target 保持线上形态', () => {
  const result = convert('OPTIONS * HTTP/1.1\nHost: example.com\n');
  // URL 只承载 authority（不拼接 *）；--request-target 让 curl 原样发送 target
  assertEquals(
    result.command,
    "curl --disable --request 'OPTIONS' --header 'User-Agent:' --header 'Accept:' --request-target '*' 'https://example.com'",
  );
  assertEquals(result.warnings.length, 1);
  if (!/asterisk-form/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

// ===== shell=powershell：引号方言切换 =====

// PS 单引号串内撇号按 '' 翻倍转义（sh 是 '\''）；程序名用 curl.exe 避开
// Windows PowerShell 5.1 的 Invoke-WebRequest 别名
Deno.test('shell: powershell 撇号翻倍 + curl.exe', () => {
  const result = convert(
    "POST /a HTTP/1.1\nHost: example.com\nContent-Type: text/plain\n\nit's ok",
    { shell: 'powershell' },
  );
  assertEquals(
    result.command,
    "curl.exe --disable --header 'User-Agent:' --header 'Accept:' --header 'Content-Type: text/plain' --data-raw 'it''s ok' 'https://example.com/a'",
  );
  assertEquals(result.warnings, []);
});

Deno.test('shell: powershell header 撇号同样翻倍', () => {
  const result = convert("GET / HTTP/1.1\nHost: example.com\nX-Msg: don't\n", {
    shell: 'powershell',
  });
  assertEquals(
    result.command,
    "curl.exe --disable --header 'User-Agent:' --header 'Accept:' --header 'X-Msg: don''t' 'https://example.com/'",
  );
  assertEquals(result.warnings, []);
});

// 默认（不传 shell）仍是 POSIX 方言：'\'' 转义 + 裸 curl
Deno.test('shell: 默认 sh 方言回归', () => {
  const result = convert(
    "POST /a HTTP/1.1\nHost: example.com\nContent-Type: text/plain\n\nit's ok",
  );
  assertEquals(
    result.command,
    "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Content-Type: text/plain' --data-raw 'it'\\''s ok' 'https://example.com/a'",
  );
  assertEquals(result.warnings, []);
});

// ===== --user 的方言转义：Basic 凭据含撇号时 powershell 也要按 '' 翻倍 =====

Deno.test('shell: powershell Basic 凭据撇号翻倍', () => {
  const encoded = btoa("alice:it's");
  const result = convert(
    `GET / HTTP/1.1\nHost: example.com\nAuthorization: Basic ${encoded}\n`,
    { shell: 'powershell' },
  );
  assertEquals(
    result.command,
    "curl.exe --disable --user 'alice:it''s' --header 'User-Agent:' --header 'Accept:' 'https://example.com/'",
  );
  assertEquals(result.warnings, []);
});

// 对照：sh 方言下撇号凭据仍是 '\'' 转义
Deno.test('shell: sh Basic 凭据撇号转义', () => {
  const encoded = btoa("alice:it's");
  const result = convert(
    `GET / HTTP/1.1\nHost: example.com\nAuthorization: Basic ${encoded}\n`,
  );
  assertEquals(
    result.command,
    "curl --disable --user 'alice:it'\\''s' --header 'User-Agent:' --header 'Accept:' 'https://example.com/'",
  );
  assertEquals(result.warnings, []);
});

// ===== powershell 方言 + 参数值含双引号：PS 5.1 传参会破坏此类参数，提示需 7.3+ =====

Deno.test('shell: powershell 参数含双引号提示 PS 5.1 兼容性', () => {
  const result = convert(
    'POST /a HTTP/1.1\nHost: example.com\nContent-Type: application/json\n\n{"x": 1, "y": "z z"}',
    { shell: 'powershell' },
  );
  // 命令照常生成（语法本身正确），仅追加 warning
  assert(/--data-raw/.test(result.command));
  assertEquals(result.warnings.length, 1);
  if (!/PowerShell 5\.1/.test(result.warnings[0])) {
    throw new Error(`unexpected warning: ${result.warnings[0]}`);
  }
});

// 对照：sh 方言下双引号参数无此问题，不产生 warning
Deno.test('shell: sh 参数含双引号无 warning', () => {
  const result = convert(
    'POST /a HTTP/1.1\nHost: example.com\nContent-Type: application/json\n\n{"x": 1}',
  );
  assert(/--data-raw/.test(result.command));
  assertEquals(result.warnings, []);
});

// ===== 安全回归：method 注入（C1）=====

// 非 RFC token 的 method 拒绝转换（含分号、$() 、反引号等 shell 注入载荷）
Deno.test('security: 非 token method 拒绝转换', () => {
  assertThrows(
    () => convert('x;id / HTTP/1.1\nHost: example.com\n'),
    Error,
    'invalid HTTP method',
  );
  assertThrows(
    () => convert('GET$(id) / HTTP/1.1\nHost: example.com\n'),
    Error,
    'invalid HTTP method',
  );
  assertThrows(
    () => convert('a(b / HTTP/1.1\nHost: example.com\n'),
    Error,
    'invalid HTTP method',
  );
});

// 合法 token 自身含 shell 元字符（& | ' 等）：校验不能省略 quote，输出必须仍被引用
Deno.test('security: 合法 token method 含 shell 元字符仍无条件引用', () => {
  const result = convert('patch&x / HTTP/1.1\nHost: example.com\n');
  assertEquals(
    result.command,
    "curl --disable --request 'patch&x' --header 'User-Agent:' --header 'Accept:' 'https://example.com/'",
  );
});

// method 保留原大小写（扩展 method 区分大小写），仅分支判断用大写副本
Deno.test('security: method 保留原大小写', () => {
  const result = convert('patch / HTTP/1.1\nHost: example.com\n');
  assert(result.command.includes("--request 'patch'"));
});

// ===== 安全回归：body 前导 @ 不得触发本地文件读取（C2）=====

// --data-binary 会把前导 @ 的 body 当本地路径读取并上传；--data-raw 禁用 @ 元语法
Deno.test('security: @ 开头的 body 用 --data-raw 字面发送', () => {
  const result = convert('POST /collect HTTP/1.1\nHost: receiver.example\n\n@/etc/passwd');
  assert(result.command.includes("--data-raw '@/etc/passwd'"));
  assert(!result.command.includes('--data-binary'));
});

Deno.test('security: @- 开头（stdin）的 body 同样字面发送', () => {
  const result = convert('POST /collect HTTP/1.1\nHost: receiver.example\n\n@-');
  assert(result.command.includes("--data-raw '@-'"));
});

// ===== 安全回归：Host authority 校验（H2）=====

// userinfo 会把 "trusted.example@127.0.0.1" 的实际连接主机变成 127.0.0.1
Deno.test('security: Host 含 userinfo 拒绝（目标主机混淆）', () => {
  assertThrows(
    () => convert('GET /safe HTTP/1.1\nHost: trusted.example@127.0.0.1\n'),
    Error,
    'userinfo',
  );
});

Deno.test('security: Host 含 path/query/fragment 拒绝', () => {
  assertThrows(
    () => convert('GET / HTTP/1.1\nHost: example.com/evil\n'),
    Error,
    'invalid Host',
  );
  assertThrows(
    () => convert('GET / HTTP/1.1\nHost: example.com?a=1\n'),
    Error,
    'invalid Host',
  );
  assertThrows(
    () => convert('GET / HTTP/1.1\nHost: example.com#f\n'),
    Error,
    'invalid Host',
  );
});

Deno.test('security: Host 端口越界/非数字拒绝', () => {
  assertThrows(
    () => convert('GET / HTTP/1.1\nHost: example.com:99999\n'),
    Error,
    'out of range',
  );
  assertThrows(
    () => convert('GET / HTTP/1.1\nHost: example.com:8o80\n'),
    Error,
    'invalid port',
  );
});

Deno.test('security: Host IPv6 bracket 形态正常接受', () => {
  const result = convert('GET / HTTP/1.1\nHost: [::1]:8080\n');
  assert(result.command.includes("'https://[::1]:8080/'"));
  assertEquals(result.warnings, []);
});

// ===== 回归：全部 Transfer-Encoding 头与逗号 token（H3）=====

Deno.test('chunked: 第二条 TE 头的 chunked 也能拒绝', () => {
  assertThrows(
    () =>
      convert(
        'POST / HTTP/1.1\nHost: x.example\nTransfer-Encoding: gzip\nTransfer-Encoding: chunked\n\n0\r\n\r\n',
      ),
    ConvertWarning,
    'chunked',
  );
});

Deno.test('chunked: 单条 TE 内逗号 token 的 chunked 也能拒绝', () => {
  assertThrows(
    () =>
      convert('POST / HTTP/1.1\nHost: x.example\nTransfer-Encoding: gzip, chunked\n\n0\r\n\r\n'),
    ConvertWarning,
    'chunked',
  );
});

Deno.test('chunked: TE + CL 组合提醒请求走私特征', () => {
  const result = convert(
    'POST / HTTP/1.1\nHost: x.example\nTransfer-Encoding: gzip\nContent-Length: 5\n\nhello',
  );
  assertEquals(result.warnings.length, 1);
  assert(result.warnings[0].includes('smuggling'));
});

// ===== 安全回归：--disable 为第一个 curl 参数（M2）=====

Deno.test('security: --disable 是 curl 的第一个参数', () => {
  const result = convert('GET / HTTP/1.1\nHost: example.com\n');
  assert(result.command.startsWith('curl --disable '));
  const ps = convert('GET / HTTP/1.1\nHost: example.com\n', { shell: 'powershell' });
  assert(ps.command.startsWith('curl.exe --disable '));
});
