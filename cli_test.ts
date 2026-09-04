// CLI 黑盒测试：以子进程方式真实运行 cli.ts，断言 stdout/stderr/退出码。
// 不 import convert 逻辑——保证测的是 CLI 面向用户的行为（参数解析、IO、错误呈现）。
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';

const CLI = new URL('./cli.ts', import.meta.url).pathname;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** 运行 CLI：args 传命令行参数，input 为 stdin 内容（默认空且非终端） */
async function run(args: string[], input = ''): Promise<RunResult> {
  // 按名称（而非绝对路径）spawn：--allow-run=deno 校验的是程序名，
  // 绝对路径会因环境不同（uv 安装、homebrew 等）无法静态列出
  const cmd = new Deno.Command('deno', {
    args: ['run', '--allow-read', '--allow-net=127.0.0.1', CLI, ...args],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  writer.close();
  const out = await child.output();
  return {
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    code: out.code,
  };
}

const REQUEST = 'GET / HTTP/1.1\nHost: example.com\n';
const EXPECTED =
  "curl --disable --header 'User-Agent:' --header 'Accept:' --header 'Host: example.com' 'https://example.com/'";

Deno.test('cli: 从 stdin 读取并输出命令，退出码 0', async () => {
  const r = await run([], REQUEST);
  assertEquals(r.code, 0);
  assertEquals(r.stdout.trim(), EXPECTED);
  assertEquals(r.stderr, '');
});

Deno.test('cli: 从文件读取', async () => {
  const r = await run(['testdata/01_get.http']);
  assertEquals(r.code, 0);
  assertEquals(r.stdout.trim(), EXPECTED);
});

Deno.test('cli: 文件参数为 - 时从 stdin 读取', async () => {
  const r = await run(['-'], REQUEST);
  assertEquals(r.code, 0);
  assertEquals(r.stdout.trim(), EXPECTED);
});

Deno.test('cli: -- 之后参数全部按文件名处理', async () => {
  // 用 -- 传入一个名字长得像选项的文件：此处借不存在文件验证它被当作文件而非选项
  const r = await run(['--', '--shell']);
  assertEquals(r.code, 1);
  assert(r.stderr.includes("cannot read '--shell'"));
  assert(!r.stderr.includes('unknown option'));
});

Deno.test('cli: 文件不存在 → 友好错误 + 退出码 1', async () => {
  const r = await run(['/nonexistent/request.http']);
  assertEquals(r.code, 1);
  assert(r.stderr.startsWith("h2c: cannot read '/nonexistent/request.http':"));
  assertEquals(r.stdout, '');
});

Deno.test('cli: 未知选项 → 退出码 1 + 提示', async () => {
  const r = await run(['--frobnicate'], REQUEST);
  assertEquals(r.code, 1);
  assert(r.stderr.includes("unknown option '--frobnicate'"));
  assertEquals(r.stdout, '');
});

Deno.test('cli: --help → Usage + 退出码 0', async () => {
  const r = await run(['--help']);
  assertEquals(r.code, 0);
  assert(r.stdout.includes('Usage:'));
  assert(r.stdout.includes('--version'));
});

Deno.test('cli: --version → 版本号 + 退出码 0', async () => {
  const denoJson = JSON.parse(await Deno.readTextFile('deno.json'));
  const r = await run(['--version']);
  assertEquals(r.code, 0);
  assertEquals(r.stdout.trim(), denoJson.version);
});

Deno.test('cli: warning 走 stderr，命令仍输出且退出码 0', async () => {
  // CL 与 body 不一致 → warning（stderr），命令照常生成（stdout），退出码 0
  const r = await run([], 'POST /api HTTP/1.1\nHost: example.com\nContent-Length: 100\n\nhi');
  assertEquals(r.code, 0);
  assert(r.stdout.includes('--data-raw'));
  assert(r.stderr.includes('h2c: warning:'));
  assert(r.stderr.includes('Content-Length'));
});

Deno.test('cli: 无法忠实转换（chunked）→ 退出码 1 + stderr', async () => {
  const r = await run(
    [],
    'POST / HTTP/1.1\nHost: example.com\nTransfer-Encoding: chunked\n\n0\r\n\r\n',
  );
  assertEquals(r.code, 1);
  assert(r.stderr.includes('h2c: warning:'));
  assert(r.stderr.includes('chunked'));
  assertEquals(r.stdout, '');
});

Deno.test('cli: 多文件 → 退出码 1 + 提示', async () => {
  const r = await run(['testdata/01_get.http', 'testdata/02_head.http']);
  assertEquals(r.code, 1);
  assert(r.stderr.includes('only one input file'));
});
