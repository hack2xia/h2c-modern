// h2c-modern: headers to curl —— 核心转换逻辑（纯函数，无 IO 依赖）
// 输入一段原始 HTTP 请求报文，输出对应的 curl 命令行。

/** 输出目标的 shell 引号方言 */
export type ShellTarget = 'sh' | 'powershell';

/** 转换选项 */
export interface Options {
  /** 使用短选项（-H / -b / -A / -u / -I / -X / -v / -F），默认 false */
  shortOpt?: boolean;
  /** 追加 --verbose，默认 false */
  verbose?: boolean;
  /** 允许 curl 的默认请求头（不抑制 Accept / User-Agent），默认 false */
  allowDefaultHeaders?: boolean;
  /** 输出 --http1.0 / --http1.1 / --http2，默认 false */
  sameHttpVersion?: boolean;
  /** 使用 http:// 而非 https://，默认 false */
  useHttp?: boolean;
  /**
   * 输出引号方言：sh（POSIX，内嵌单引号按 '\'' 转义）或 powershell（单引号串内
   * 按 '' 翻倍转义），默认 sh。两种方言下其余生成逻辑完全一致——curl 的选项语法
   * 与目标 shell 无关。
   */
  shell?: ShellTarget;
}

interface Header {
  name: string;
  value: string;
}

interface ParsedRequest {
  method: string;
  path: string;
  httpVersion: string;
  headers: Header[];
  body: string;
}

/** 解析结果：请求结构 + 解析阶段产生的非阻断提醒 */
interface ParseResult {
  req: ParsedRequest;
  warnings: string[];
}

/** 解析原始 HTTP 请求报文
 * 总原则：明显错误抛异常拒绝；可能有问题则尽量解析并记录 warning。
 */
function parse(input: string): ParseResult {
  const warnings: string[] = [];
  // 定位 header / body 分隔点：取 \r\n\r\n 与 \n\n 中最早出现的那个。
  // 必须同时取两者最小，否则当 header 用 LF 而 body（如 chunked 终止符 0\r\n\r\n）
  // 含 CRLF CRLF 时，会被错误地切到 body 末尾。
  const crlfIdx = input.indexOf('\r\n\r\n');
  const lfIdx = input.indexOf('\n\n');
  let sepIdx: number;
  let sepLen: number;
  if (crlfIdx === -1 && lfIdx === -1) {
    sepIdx = -1;
    sepLen = 0;
  } else if (crlfIdx === -1) {
    sepIdx = lfIdx;
    sepLen = 2;
  } else if (lfIdx === -1) {
    sepIdx = crlfIdx;
    sepLen = 4;
  } else {
    // 两者都存在，取较小者
    if (crlfIdx <= lfIdx) {
      sepIdx = crlfIdx;
      sepLen = 4;
    } else {
      sepIdx = lfIdx;
      sepLen = 2;
    }
  }

  const headerSection = sepIdx === -1 ? input : input.slice(0, sepIdx);
  const body = sepIdx === -1 ? '' : input.slice(sepIdx + sepLen);

  const lines = headerSection.split(/\r\n|\n/);
  if (lines.length === 0 || !lines[0].trim()) {
    throw new Error('empty request');
  }

  const requestLine = lines[0].trim();
  const parts = requestLine.split(/\s+/);
  // 请求行必须是 "METHOD target [HTTP/x]" 两到三段：
  // 多于三段通常是 URL 含未编码空格，静默截断会丢数据，属明显错误
  if (
    parts.length < 2 || parts.length > 3 ||
    (parts[2] && !parts[2].toUpperCase().startsWith('HTTP/'))
  ) {
    throw new Error(`invalid request line: ${requestLine}`);
  }

  const method = parts[0];
  const path = parts[1];
  const httpVersion = parts[2] ?? 'HTTP/1.1';

  // request-target 形态校验（RFC 7230 §5.3）：HTTP/1.x 只允许 origin-form（/ 开头）、
  // absolute-form（完整 URL）、asterisk-form（仅 OPTIONS）、authority-form（仅 CONNECT）。
  // 裸 "foo" 或非 CONNECT 的 authority-form 若静默拼接会产出 host/path 粘连的垃圾 URL
  // （如 https://example.comfoo），属明显错误，拒绝。
  const upperMethod = method.toUpperCase();
  if (
    !path.startsWith('/') && !/^https?:\/\//i.test(path) && path !== '*' &&
    upperMethod !== 'CONNECT'
  ) {
    throw new Error(
      `invalid request-target "${path}": expected origin-form (/...), absolute-form (http://...), or asterisk-form (OPTIONS *)`,
    );
  }
  if (path === '*' && upperMethod !== 'OPTIONS') {
    throw new Error(
      `asterisk-form request-target is only valid for OPTIONS (got ${upperMethod})`,
    );
  }

  const headers: Header[] = [];
  let obsFolded = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // obs-fold：以空白开头的行是上一个 header 的续行（RFC 7230 已废弃，但实流量中存在）
    if ((line[0] === ' ' || line[0] === '\t') && headers.length > 0) {
      headers[headers.length - 1].value += ' ' + line.trim();
      obsFolded = true;
      continue;
    }
    // HTTP/2 伪头以冒号开头（:method / :path / :authority 等），不属于 HTTP/1.x 语法，
    // 静默当成普通 header 解析会产出语义错乱的命令。明确拒绝并提示。
    if (line[0] === ':') {
      throw new Error(
        `HTTP/2 pseudo-headers are not supported: ${line} (h2c only handles HTTP/1.x request messages)`,
      );
    }
    const colon = line.indexOf(':');
    if (colon === -1) {
      // 无冒号的非空 header 行是明显格式错误，静默跳过会丢数据
      throw new Error(`invalid header line: ${line}`);
    }
    const rawName = line.slice(0, colon);
    const rawValue = line.slice(colon + 1);
    // field-name (RFC 7230) 是 token，不允许前后空白；含空白属非法但实流量中可能存在
    if (rawName !== rawName.trim()) {
      warnings.push(
        `header name "${rawName}" has surrounding whitespace; stripped (RFC 7230 field-name does not allow whitespace)`,
      );
    }
    headers.push({
      name: rawName.trim(),
      // value 原样保留：包含冒号后的所有字节（含前导/后导 OWS）。
      // 剥离 OWS 是 RFC 等价变换，但安全工具可能故意构造多空格/HTAB 作为 payload
      // （服务端按原始行解析时不等价）；由后续输出环节判断标准 vs 非标准 OWS 决定处理方式。
      value: rawValue,
    });
  }
  if (obsFolded) {
    warnings.push('request contains obs-fold (deprecated header folding); unfolded per RFC 7230');
  }

  // chunked Transfer-Encoding：流式语义无法用 curl 命令表达，调用方应拒绝
  // 这里仅解析，不解码；由 convert() 检测并抛错。

  return { req: { method, path, httpVersion, headers, body }, warnings };
}

/** 大小写不敏感地取 header 值 */
function getHeader(headers: Header[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** 大小写不敏感地取某 header 的所有值（保持出现顺序） */
function getHeaderValues(headers: Header[], name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value);
}

/** 单引号转义，安全用于 shell */
function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * 判断 header value 是否为标准 OWS：
 * RFC 7230 允许 field-value 前后任意 OWS（SP/HTAB），但最常见形态是
 * (无前导 | 1 个前导 SP) + content + (无后导 OWS)。
 * 非标准 OWS（多空格 / HTAB / 后导空白）可能是安全工具故意构造的 payload
 * （服务端按原始行解析时不剥离 OWS），不应被静默剥离。
 */
function isStandardOWS(rawValue: string): boolean {
  if (/[ \t]$/.test(rawValue)) return false; // 后导 OWS
  if (rawValue.startsWith('  ') || rawValue.startsWith('\t')) return false; // 多空格 / HTAB 前导
  return true; // 无前导 OWS 或恰好 1 个前导 SP
}

/** 取标准 OWS 的 value：剥掉前导单个 SP（如有）。调用前应已通过 isStandardOWS 校验。 */
function stripStandardOWS(rawValue: string): string {
  return rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
}

/** 判断是否为 multipart/form-data 请求体 */
function isMultipart(req: ParsedRequest): boolean {
  const ct = getHeader(req.headers, 'content-type');
  return !!ct && ct.toLowerCase().includes('multipart/form-data');
}

/** 解析 multipart body，返回 --form 的参数列表（不含选项名）
 * @throws 缺 boundary 或解析不出任何 part 时抛 ConvertWarning——
 *   静默输出会丢失请求体语义，宁可拒绝并提示用户检查原始请求。
 */
function parseMultipart(req: ParsedRequest): string[] {
  const ct = getHeader(req.headers, 'content-type')!;
  const m = ct.match(/boundary=("?)([^";]+)\1/i);
  if (!m) {
    throw new ConvertWarning(
      'multipart/form-data is missing the boundary parameter; cannot parse the body. Check that the original request is complete.',
    );
  }
  const boundary = m[2];
  const delimiter = '--' + boundary;

  const forms: string[] = [];
  const segments = req.body.split(delimiter);

  for (const seg of segments) {
    // 去除首尾换行
    let part = seg;
    part = part.replace(/^\r?\n/, '');
    part = part.replace(/\r?\n$/, '');
    if (!part || part === '--') continue;

    // 分离 part header 与 part body
    let sep = part.indexOf('\r\n\r\n');
    let sepLen = 4;
    if (sep === -1) {
      sep = part.indexOf('\n\n');
      sepLen = 2;
    }
    if (sep === -1) continue;

    const partHeaders = part.slice(0, sep);
    const partBody = part.slice(sep + sepLen);

    const cdMatch = partHeaders.match(
      /Content-Disposition:\s*form-data;[^\r\n]*/i,
    );
    if (!cdMatch) continue;
    const cd = cdMatch[0];
    const nameMatch = cd.match(/name="([^"]*)"/i);
    const fileMatch = cd.match(/filename="([^"]*)"/i);
    const name = nameMatch ? nameMatch[1] : '';

    if (fileMatch) {
      forms.push(`${name}=@${fileMatch[1]}`);
    } else {
      forms.push(`${name}=${partBody}`);
    }
  }

  if (forms.length === 0 && req.body.trim()) {
    throw new ConvertWarning(
      'failed to parse multipart body: boundary exists but no parts found. Check that the original request is complete.',
    );
  }

  return forms;
}

/** 转换警告：可恢复但应让用户知晓的问题（如 chunked 无法表达） */
export class ConvertWarning extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConvertWarning';
  }
}

/** 转换结果 */
export interface ConvertResult {
  /** 生成的 curl 命令行 */
  command: string;
  /** 非阻断提醒：请求可能有问题，但已照常生成（总原则第 2 条） */
  warnings: string[];
}

/**
 * 将一段原始 HTTP 请求报文转换为 curl 命令行。
 * 总原则：1. 请求有明显错误 → 抛异常拒绝（Error / ConvertWarning）；
 *         2. 请求可能有问题 → 照常生成，并在返回值 warnings 中提醒。
 * @throws 格式错误抛 Error；遇到 chunked 等无法忠实表达的语义时抛 ConvertWarning
 */
export function convert(httpText: string, options: Options = {}): ConvertResult {
  const opts = {
    shortOpt: false,
    verbose: false,
    allowDefaultHeaders: false,
    sameHttpVersion: false,
    useHttp: false,
    shell: 'sh' as ShellTarget,
    ...options,
  };

  // 引号方言分发：两种 shell 的单引号串都除引号字符外全字面，差异只在转义习语——
  // POSIX 用 '\''（闭合、转义引号、重开），PowerShell 用 ''（翻倍）。
  const q = opts.shell === 'powershell'
    ? (s: string): string => "'" + s.replaceAll("'", "''") + "'"
    : shQuote;

  const { req, warnings } = parse(httpText);
  const method = req.method.toUpperCase();

  // CONNECT 是代理隧道控制报文：语义依赖代理连接本身，单条 curl 命令无法表达隧道语义，
  // 与 chunked 同属"无法忠实表达"，拒绝（复现流量应使用 --proxy 系列选项而非转换报文）。
  if (method === 'CONNECT') {
    throw new ConvertWarning(
      'CONNECT is a proxy tunnel control message; a single curl command cannot express tunnel semantics (reproduce the traffic with --proxy options instead). Refusing to convert.',
    );
  }

  // 请求体含 U+FFFD 替换字符：输入是已解码的字符串，替换字符意味着原始报文里有
  // 二进制/非 UTF-8 字节（粘贴/解码过程已损坏）。shell 参数无法承载任意字节，
  // 生成的命令必然发送错误数据，拒绝；建议提取 body 为文件后手动用 --data-binary @文件。
  if (req.body.includes('\uFFFD')) {
    throw new ConvertWarning(
      'body contains U+FFFD replacement characters — the original message most likely contains binary or non-UTF-8 bytes that were already corrupted during pasting/decoding. Shell arguments cannot carry arbitrary bytes; refusing to convert. Extract the body into a file and use --data-binary @file manually.',
    );
  }

  // absolute-form 请求行（GET http://host/path）：URL 自包含，可直接使用
  const absoluteForm = /^https?:\/\//i.test(req.path);

  // asterisk-form 请求行（OPTIONS *）：target 不是路径。curl 默认把 * 当路径拼进 URL，
  // 改变线上形态；--request-target 可让 curl 原样发送 *（需 curl ≥ 7.55）
  const asteriskForm = req.path === '*';

  // Host：多个 Host 头 RFC 7230 要求必须拒绝（明显错误）；
  // absolute-form 时 Host 可缺省（URL 已含 authority）
  const hostValues = getHeaderValues(req.headers, 'host');
  if (hostValues.length > 1) {
    throw new Error('multiple Host headers');
  }
  // Host 头 value 现在原样保留（含前导 OWS）；URL 中不允许空白字节，
  // 故统一剥离。对非标准 OWS（多空格/HTAB/后导空白）追加 warning。
  let host = hostValues[0];
  if (host !== undefined) {
    if (isStandardOWS(host)) {
      host = stripStandardOWS(host);
    } else {
      warnings.push(
        'Host header has non-standard OWS; all whitespace stripped for the URL (URLs cannot contain whitespace bytes)',
      );
      host = host.trim();
    }
  }
  if (!host && !absoluteForm) {
    throw new Error('missing Host header');
  }
  if (absoluteForm) {
    warnings.push('request line is absolute-form (contains a full URL); using that URL directly');
    let authority: string | undefined;
    try {
      authority = new URL(req.path).host;
    } catch {
      throw new Error(`invalid absolute URI in request line: ${req.path}`);
    }
    if (host && host !== authority) {
      warnings.push(
        `absolute-form URL authority (${authority}) does not match the Host header (${host}); using the URL from the request line`,
      );
    }
  }

  // Content-Length：curl 会自动计算，一律跳过；但重复头需要甄别
  const clValues = getHeaderValues(req.headers, 'content-length');
  if (clValues.length > 1) {
    if (new Set(clValues).size === 1) {
      warnings.push(
        'multiple identical Content-Length headers; ignored (curl computes it automatically)',
      );
    } else {
      // 值不一致的重复 CL 是请求走私特征，curl 无法忠实表达
      throw new ConvertWarning(
        'multiple Content-Length headers with different values (an HTTP request smuggling signature); a curl command cannot express this faithfully. Refusing to convert.',
      );
    }
  }
  // 单个 Content-Length：与 body 实际字节数比对。
  // 不一致时 curl 会按实际长度重算、静默改变线上字节，属"可能有问题"，应提醒；
  // 声明长度大于实际时，多半是粘贴/日志截断，提示更明确。
  if (clValues.length === 1) {
    const cl = clValues[0].trim();
    if (!/^\d+$/.test(cl)) {
      warnings.push(
        `Content-Length value "${cl}" is not a valid number; ignored (curl computes it from the actual body)`,
      );
    } else {
      const actual = new TextEncoder().encode(req.body).length;
      const declared = Number(cl);
      if (declared !== actual) {
        if (actual < declared) {
          warnings.push(
            `Content-Length declares ${declared} bytes but the body is only ${actual} bytes — the body may be truncated; check the original request (curl will send the actual length)`,
          );
        } else {
          warnings.push(
            `Content-Length declares ${declared} bytes but the body is ${actual} bytes — inconsistent; curl will send the actual length`,
          );
        }
      }
    }
  }

  // chunked Transfer-Encoding 是流式语义，curl 命令行无法忠实表达：
  // 服务端可能依赖分块边界（如流式上传/大 body），且命令行长度受限。
  // 解码后改用 --data-binary 会改变 wire format，故拒绝转换。
  const te = getHeader(req.headers, 'transfer-encoding');
  if (te && /\bchunked\b/i.test(te)) {
    throw new ConvertWarning(
      'Transfer-Encoding: chunked cannot be converted to an equivalent curl command: streaming chunk semantics are lost on a command line, and decoding would change the wire format. Retry with a Content-Length body instead.',
    );
  }

  const multipart = isMultipart(req);
  // powershell 档用 curl.exe：Windows PowerShell 5.1 把裸 curl 别名到 Invoke-WebRequest，
  // 会把整条命令喂给错误的 cmdlet；curl.exe 在 Windows PowerShell 与 pwsh 下都直指真 curl。
  // （pwsh on Linux/macOS 无此别名，但该档位面向 Windows 用户。）
  const args: string[] = [opts.shell === 'powershell' ? 'curl.exe' : 'curl'];

  const opt = (long: string, short: string): string => opts.shortOpt ? short : long;

  // 1. verbose
  if (opts.verbose) {
    args.push(opt('--verbose', '-v'));
  }

  // 2. HTTP 版本
  if (opts.sameHttpVersion) {
    const v = req.httpVersion.toUpperCase();
    if (v === 'HTTP/1.0') args.push('--http1.0');
    else if (v === 'HTTP/1.1') args.push('--http1.1');
    else if (v === 'HTTP/2') args.push('--http2');
    else warnings.push(`unrecognized HTTP version ${req.httpVersion}; no version option emitted`);
  }

  // 3. 方法
  // HEAD / GET 带 body：--data-binary 会让 curl 自动把方法切成 POST，
  // --head 与 --data-binary 更是直接互斥（curl 报错），必须显式 --request 保持方法。
  // 这种形态非标准但可表达：照常生成 + warning。
  if (method === 'HEAD') {
    if (req.body) {
      args.push(opt('--request', '-X'), 'HEAD');
      warnings.push(
        'HEAD request with a body (non-standard but expressible with curl); using --request HEAD to keep the method; some servers/proxies reject such requests',
      );
    } else {
      args.push(opt('--head', '-I'));
    }
  } else if (method === 'GET' && req.body) {
    args.push(opt('--request', '-X'), 'GET');
    warnings.push(
      'GET request with a body (non-standard but expressible with curl); added --request GET to keep the method; some servers/proxies reject such requests',
    );
  } else if (method !== 'GET' && method !== 'POST') {
    args.push(opt('--request', '-X'), method);
  }

  // 重复头的处理原则：恰好一个 → 用专属选项（输出更可读）；
  // 出现重复 → 全部按原始顺序逐条透传为 -H，专属选项完全不用。
  // 原因：合并/拆分会改变 wire format，而服务端实现未必按 RFC 把同名头视作等价
  // （有的只取第一个，有的按原始行解析）；安全工具更是常故意构造重复头。
  // 且 -H 同名头会抑制 curl 内部生成的头（如 -b 的 Cookie、-A 的 UA），混用会丢数据。
  //
  // OWS 处理原则：专属选项（-A / -b / -u / --compressed）由 curl 内部生成 header 行，
  // 无法精确控制前导/后导空白；当 value 含非标准 OWS（多空格/HTAB/后导空格）时，
  // 改走 -H 原样透传以保持 wire format，并追加 warning 提醒用户。

  // 4. User-Agent
  const uaValues = getHeaderValues(req.headers, 'user-agent');
  if (uaValues.length === 1) {
    const ua = uaValues[0];
    if (isStandardOWS(ua)) {
      args.push(opt('--user-agent', '-A'), q(stripStandardOWS(ua)));
    } else {
      warnings.push(
        'User-Agent header has non-standard OWS (leading spaces/HTAB/trailing whitespace); passed through as -H to preserve the wire format',
      );
    }
  }

  // 5. Cookie
  const cookieValues = getHeaderValues(req.headers, 'cookie');
  if (cookieValues.length === 1) {
    const cookie = cookieValues[0];
    if (isStandardOWS(cookie)) {
      args.push(opt('--cookie', '-b'), q(stripStandardOWS(cookie)));
    } else {
      warnings.push(
        'Cookie header has non-standard OWS (leading spaces/HTAB/trailing whitespace); passed through as -H to preserve the wire format',
      );
    }
  }

  // 6. Accept-Encoding: 含 gzip/deflate/br/zstd 任一 -> --compressed
  let encodingConsumed = false;
  const aeValues = getHeaderValues(req.headers, 'accept-encoding');
  if (aeValues.length === 1) {
    const ae = aeValues[0];
    if (isStandardOWS(ae) && /(gzip|deflate|br|zstd)/i.test(ae)) {
      args.push('--compressed');
      encodingConsumed = true;
    } else if (!isStandardOWS(ae)) {
      warnings.push(
        'Accept-Encoding header has non-standard OWS; passed through as -H (not using --compressed, to preserve the wire format)',
      );
    }
  }

  // 7. Basic 认证（仅 Basic 转 --user；Bearer/Digest 等保留为普通 header）
  let authConsumed = false;
  const auth = getHeaderValues(req.headers, 'authorization');
  if (auth.length === 1) {
    const av = auth[0];
    if (isStandardOWS(av)) {
      const stripped = stripStandardOWS(av);
      if (/^basic\s+/i.test(stripped)) {
        const encoded = stripped.replace(/^basic\s+/i, '').trim();
        try {
          const decoded = atob(encoded);
          if ([...decoded].some((c) => c.charCodeAt(0) > 0x7f)) {
            // 解码后超出 user:password 常规字符范围：RFC 7617 未规定编码，
            // 猜编码重编码会改变 wire format，故原样透传 Authorization 头并提醒
            warnings.push(
              'Basic credentials decode to non-ASCII bytes; passing the Authorization header through verbatim (not guessing an encoding) — please verify',
            );
          } else {
            args.push(opt('--user', '-u'), q(decoded));
            authConsumed = true;
          }
        } catch {
          // base64 解码失败，作为普通 header 处理
        }
      }
    } else {
      warnings.push(
        'Authorization header has non-standard OWS; passed through as -H to preserve the wire format',
      );
    }
  }

  // 8. 请求头
  // host / content-length 由 curl 全权管理，一律跳过
  const alwaysSkip = new Set(['host', 'content-length']);
  // 已被专属选项消费的（恰好一个且 OWS 标准的特殊头）；非标准 OWS 或重复的会原样透传
  const consumed = new Set<string>();
  if (uaValues.length === 1 && isStandardOWS(uaValues[0])) consumed.add('user-agent');
  if (cookieValues.length === 1 && isStandardOWS(cookieValues[0])) consumed.add('cookie');
  if (encodingConsumed) consumed.add('accept-encoding');
  if (authConsumed) consumed.add('authorization');
  if (multipart) consumed.add('content-type');

  // 默认头抑制
  if (!opts.allowDefaultHeaders) {
    if (uaValues.length === 0) {
      args.push(opt('--header', '-H'), q('User-Agent:'));
    }
    if (getHeader(req.headers, 'accept') === undefined) {
      args.push(opt('--header', '-H'), q('Accept:'));
    }
  }

  for (const h of req.headers) {
    const key = h.name.toLowerCase();
    if (alwaysSkip.has(key) || consumed.has(key)) continue;
    // 不插入空格：value 已原样保留冒号后所有字节（含前导 OWS），
    // 由 curl 直接发送 `-H 'Name: value'` / `-H 'Name:value'` / `-H 'Name:  value'` 等形态。
    args.push(opt('--header', '-H'), q(`${h.name}:${h.value}`));
  }

  // 9. 请求体
  // --data-binary 会让 curl 注入默认头 Content-Type: application/x-www-form-urlencoded；
  // 原请求没有 Content-Type 时必须以 -H 'Content-Type:' 清空（与 Accept / User-Agent 的
  // 默认头抑制同一手法），否则线上字节被改变。
  const hasContentType = getHeader(req.headers, 'content-type') !== undefined;
  const suppressDefaultCT = () => {
    if (!hasContentType) args.push(opt('--header', '-H'), q('Content-Type:'));
  };
  // 原始请求显式声明 Content-Length: 0（POST/PUT 无 body 时常见）：curl 默认一个 CL 头都
  // 不发，与原报文不一致；--data-binary '' 让 curl 实际发送 Content-Length: 0。
  // GET/HEAD 除外：--data-binary 会把方法切成 POST / 与 --head 互斥，得不偿失
  // （GET/HEAD 声明 CL:0 极罕见，维持不注入空 body）。
  const declaredZeroBody = req.body === '' && method !== 'GET' && method !== 'HEAD' &&
    clValues.length > 0 &&
    clValues.every((v) => /^\d+$/.test(v.trim()) && Number(v.trim()) === 0);
  if (multipart) {
    for (const f of parseMultipart(req)) {
      args.push(opt('--form', '-F'), q(f));
    }
  } else if (req.body) {
    suppressDefaultCT();
    args.push('--data-binary', q(req.body));
  } else if (declaredZeroBody) {
    suppressDefaultCT();
    args.push('--data-binary', q(''));
  } else if (method === 'POST') {
    // POST 无 body 且未声明 CL:0：用 --request POST 明确方法，避免 --data-binary ''
    // 注入原请求没有的 Content-Length: 0。
    // 注意：若前文已因非 GET/POST 方法追加过 --request，此处不会重复触发。
    args.push(opt('--request', '-X'), 'POST');
  }

  // 10. URL：非 ASCII 字符按 UTF-8 百分号编码（request-target 按规范只能是 ASCII；
  // 未编码字节 curl 会原样发出，多数服务器也能容忍，但严格场景下 wire format 不合法）
  const rawUrl = absoluteForm
    ? req.path
    : `${opts.useHttp ? 'http' : 'https'}://${host}${asteriskForm ? '' : req.path}`;
  const url = rawUrl.replace(/[^\p{ASCII}]+/gu, (s) => encodeURIComponent(s));
  if (url !== rawUrl) {
    warnings.push('URL contains non-ASCII characters; percent-encoded as UTF-8');
  }
  // curl glob 元字符：URL 路径/查询含 {} / [] 时，curl 默认会做 glob 展开
  // （{a,b} 发多个请求、[abc] 直接报错），必须 --globoff 按字面发送。
  // 只检查路径/查询部分：IPv6 主机的 [::1] 括号不是 glob，不能误报。
  const authorityIdx = url.indexOf('://');
  const afterAuthority = authorityIdx === -1 ? url : url.slice(authorityIdx + 3);
  const pathOrQueryIdx = afterAuthority.search(/[/?#]/);
  const pathAndQuery = pathOrQueryIdx === -1
    ? ''
    : afterAuthority.slice(pathOrQueryIdx).split('#')[0];
  if (/[\[\]{}]/.test(pathAndQuery)) {
    args.push(opt('--globoff', '-g'));
    warnings.push(
      'URL path/query contains [] or {} (curl glob metacharacters); added --globoff to send them literally (not percent-encoded, wire format unchanged)',
    );
  }
  if (asteriskForm) {
    args.push('--request-target', q('*'));
    warnings.push(
      'request line is asterisk-form (OPTIONS *); using --request-target to preserve the wire form (requires curl >= 7.55)',
    );
  }
  args.push(q(url));

  // PowerShell 方言 + 参数值含双引号：生成的命令语法正确，但 Windows PowerShell 5.1
  // 向原生程序传参时不转义参数内嵌的 "（PSNativeCommandArgumentPassing 7.3 才修复），
  // 含 " 的参数（如 JSON body）会被拆碎/丢引号。照常生成 + warning 提醒需 7.3+。
  if (opts.shell === 'powershell' && args.slice(1).some((a) => a.includes('"'))) {
    warnings.push(
      'argument value contains double quotes: Windows PowerShell 5.1 mangles such arguments when invoking native executables; run this command under PowerShell 7.3+ (pwsh)',
    );
  }

  return { command: args.join(' '), warnings };
}
