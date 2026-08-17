// h2c-modern CLI 入口：从文件或 stdin 读取 HTTP 请求，输出 curl 命令
import { convert, ConvertWarning, type Options } from './convert.ts';

const USAGE = `h2c - headers to curl

Usage:
  h2c [options] [file]
  cat request.http | h2c [options]

Options:
  -s, --short                  使用短选项（-H -b -A 等）
  -v, --verbose                追加 --verbose
  -a, --allow-default-headers  允许 curl 的默认请求头
  -i, --same-http-version      输出 --http1.1 / --http2
      --http                   使用 http:// 而非 https://
  -h, --help                   显示帮助

读取一段 HTTP 请求报文，输出对应的 curl 命令行。`;

const opts: Options = {};
const files: string[] = [];

for (const a of Deno.args) {
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
    case '-h':
    case '--help':
      console.log(USAGE);
      Deno.exit(0);
      break;
    default:
      if (a.startsWith('-')) {
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
if (files.length > 0) {
  input = Deno.readTextFileSync(files[0]);
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
