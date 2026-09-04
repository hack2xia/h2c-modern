// h2c-modern CLI 入口：从文件或 stdin 读取 HTTP 请求，输出 curl 命令
import { convert, ConvertWarning, type Options } from './convert.ts';
import denoJson from './deno.json' with { type: 'json' };

const VERSION = denoJson.version;

const USAGE = `h2c - headers to curl

Usage:
  h2c [options] [file]
  cat request.http | h2c [options]

Options:
  -s, --short                  use short options (-H -I -X etc.)
  -v, --verbose                append --verbose
  -a, --allow-default-headers  allow curl's default request headers
  -i, --same-http-version      emit --http1.1 / --http2
      --http                   use http:// instead of https://
      --shell <sh|powershell>  quoting dialect (default sh; powershell emits curl.exe)
  -h, --help                   show this help
      --version                show version

Reads a raw HTTP request message and prints a curl command line.
Reads from stdin when no file is given or the file is '-'; use '--' to stop option parsing.`;

const opts: Options = {};
const files: string[] = [];

for (let i = 0; i < Deno.args.length; i++) {
  const a = Deno.args[i];
  // '--' 之后全部按文件名处理：允许转换名字长得像选项的文件
  if (a === '--') {
    for (let j = i + 1; j < Deno.args.length; j++) files.push(Deno.args[j]);
    break;
  }
  switch (a) {
    case '-s':
    case '--short':
      opts.shortOpt = true;
      break;
    case '-v':
    case '--verbose':
      opts.verbose = true;
      break;
    case '-a':
    case '--allow-default-headers':
      opts.allowDefaultHeaders = true;
      break;
    case '-i':
    case '--same-http-version':
      opts.sameHttpVersion = true;
      break;
    case '--http':
      opts.useHttp = true;
      break;
    case '--shell': {
      const v = Deno.args[++i];
      if (v !== 'sh' && v !== 'powershell') {
        console.error(
          `h2c: --shell expects sh or powershell, got '${v ?? ''}'\n\n${USAGE}`,
        );
        Deno.exit(1);
      }
      opts.shell = v;
      break;
    }
    case '-h':
    case '--help':
      console.log(USAGE);
      Deno.exit(0);
      break;
    case '--version':
      console.log(VERSION);
      Deno.exit(0);
      break;
    default:
      // '-' 单独出现表示从 stdin 读取，不是未知选项
      if (a.startsWith('-') && a !== '-') {
        console.error(`h2c: unknown option '${a}'\n\n${USAGE}`);
        Deno.exit(1);
      }
      files.push(a);
  }
}

if (files.length > 1) {
  // 一个输入对应一条 curl 命令，多文件输出会混在一起难以区分，属明显使用错误
  console.error(`h2c: only one input file supported (got ${files.length}): ${files.join(' ')}`);
  console.error('hint: 批量转换可用 shell 循环: for f in *.http; do h2c "$f"; done');
  Deno.exit(1);
}

let input: string;
if (files.length > 0 && files[0] !== '-') {
  // 文件读取失败（不存在/无权限/是目录）给一行友好错误，而不是抛未捕获异常
  try {
    input = Deno.readTextFileSync(files[0]);
  } catch (e) {
    console.error(`h2c: cannot read '${files[0]}': ${(e as Error).message}`);
    Deno.exit(1);
  }
} else if (Deno.stdin.isTerminal()) {
  // 无参数且 stdin 是终端：不会有人工输入，直接显示帮助而不是干等
  console.error(USAGE);
  Deno.exit(1);
} else {
  // 从 stdin 读取全部文本
  input = await new Response(Deno.stdin.readable).text();
}

try {
  const result = convert(input, opts);
  // 非阻断提醒：照常输出命令，warning 走 stderr（不影响管道使用）
  for (const w of result.warnings) {
    console.error(`h2c: warning: ${w}`);
  }
  console.log(result.command);
} catch (e) {
  if (e instanceof ConvertWarning) {
    // warning：无法忠实转换，输出到 stderr，前缀标记
    console.error(`h2c: warning: ${e.message}`);
  } else {
    console.error(`h2c: ${(e as Error).message}`);
  }
  Deno.exit(1);
}
