// h2c-modern 回放测试：夹具生成的 curl 命令真实执行到本地回显服务器，
// 对比线上字节与原始报文——防止"生成正确"与"发送正确"脱节
// （如 --data-binary 触发 curl 注入默认 Content-Type，这类问题只有回放能暴露）。
//
// 归一化（双方同规则应用，不弱化断言）：
// - 行尾 LF → CRLF（夹具为 LF 文本，curl 恒发 CRLF）
// - Host 值（回放指向 127.0.0.1 随机端口）
// - Accept-Encoding 值（--compressed 由 curl 按构建生成编码列表，属文档化的有损映射）
// - Content-Length 行整体剔除：本工具把 CL 交给 curl 按实际 body 重算（原报文有/无、
//   值对/错都会被替换），body 字节一致性已单独校验，足以覆盖长度错误
// - HTTP 版本 token（版本保真由 -i 选项管辖，回放不启用；04 夹具请求行为 HTTP/2）
// - 06_multipart 单独校验：curl 重新生成 boundary（body 必然不同），
//   只验请求行 + Content-Type 形态；其 @file 引用替换为内联值，避免依赖仓库文件
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { convert } from './convert.ts';

const testdataUrl = new URL('./testdata/', import.meta.url);
const enc = new TextEncoder();
const dec = new TextDecoder();

/** 解析本项目 shQuote 风格（单引号包裹、'\'' 转义）的命令行为参数数组 */
function shSplit(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      i++;
      while (i < s.length && s[i] !== "'") cur += s[i++];
      i++; // 闭合引号
    } else if (c === '\\' && s[i + 1] === "'") {
      cur += "'";
      i += 2;
    } else if (c === ' ' || c === '\t' || c === '\n') {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function indexOfSeq(hay: Uint8Array, needle: number[]): number {
  outer:
  for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** 读完一条完整请求：先收 header，再按 Content-Length 收满 body（5s 兜底超时） */
async function readFullRequest(conn: Deno.Conn): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let headerEnd = -1;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (headerEnd !== -1) {
      const headText = dec.decode(concatBytes(chunks).slice(0, headerEnd));
      const m = /content-length: (\d+)/i.exec(headText);
      const need = headerEnd + (m ? Number(m[1]) : 0);
      if (total >= need) break;
    }
    const buf = new Uint8Array(65536);
    const n = await conn.read(buf);
    if (n === null) break;
    chunks.push(buf.slice(0, n));
    total += n;
    if (headerEnd === -1) {
      const idx = indexOfSeq(concatBytes(chunks), [13, 10, 13, 10]);
      if (idx !== -1) {
        headerEnd = idx + 4;
        // curl 对 form 上传会带 Expect: 100-continue，先回 100 让它继续发 body
        const headText = dec.decode(concatBytes(chunks).slice(0, headerEnd));
        if (/expect: 100-continue/i.test(headText)) {
          await conn.write(enc.encode('HTTP/1.1 100 Continue\r\n\r\n'));
        }
      }
    }
  }
  return concatBytes(chunks);
}

/** 归一化：行尾 CRLF、Host / Accept-Encoding 值占位、CL 行剔除、HTTP 版本占位；
 * header 行排序后比对 */
function normalizeWire(bytes: Uint8Array): string {
  let text = dec.decode(bytes);
  text = text.replace(/\r?\n/g, '\r\n');
  const sep = text.indexOf('\r\n\r\n');
  const head = sep === -1 ? text : text.slice(0, sep);
  const body = sep === -1 ? '' : text.slice(sep + 4);
  const lines = head.split('\r\n');
  const requestLine = lines[0].replace(/HTTP\/[\w.]+$/, 'HTTP/NORM');
  const headers = lines.slice(1)
    .filter((l) => l.trim() !== '')
    .filter((l) => !/^Content-Length:/i.test(l)) // curl 恒按实际 body 重算，见文件头注释
    .map((l) =>
      l.replace(/^Host:.*$/i, 'Host: NORM')
        .replace(/^Accept-Encoding:.*$/i, 'Accept-Encoding: NORM')
    )
    .sort();
  return [requestLine, ...headers, '', body].join('\r\n');
}

Deno.test('replay: 夹具生成的命令实际发送的字节与原始报文一致', async () => {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const RESP_OK = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok';
  const receivedQueue: Uint8Array[] = [];

  const server = (async () => {
    try {
      for await (const conn of listener) {
        const req = await readFullRequest(conn);
        receivedQueue.push(req);
        // HEAD 响应不带 body（协议要求），其余统一回 200
        const resp = dec.decode(req.slice(0, 5)) === 'HEAD '
          ? RESP_OK.slice(0, RESP_OK.indexOf('\r\n\r\n') + 4)
          : RESP_OK;
        await conn.write(enc.encode(resp));
        conn.close();
      }
    } catch {
      // finally 里 listener.close() 会中断 accept 迭代，属正常退出路径
    }
  })();

  try {
    const names: string[] = [];
    for (const entry of Deno.readDirSync(testdataUrl)) {
      if (entry.name.endsWith('.http')) names.push(entry.name.replace(/\.http$/, ''));
    }
    names.sort();

    for (const name of names) {
      const raw = Deno.readTextFileSync(new URL(`./${name}.http`, testdataUrl));
      const { command } = convert(raw);
      const parsed = shSplit(command);
      assertEquals(parsed[0], 'curl');

      // 末参为 URL：scheme+authority 整体重写到本地明文回显服务器（必须强制 http://，
      // 否则 curl 会对明文服务器做 TLS 握手），path/query 保持
      const url = parsed[parsed.length - 1];
      assert(/^https?:\/\//.test(url), `${name}: 末参数应为 URL，实际 ${url}`);
      parsed[parsed.length - 1] = url.replace(
        /^https?:\/\/[^/?#]+/,
        `http://127.0.0.1:${port}`,
      );

      const isMultipart = name === '06_multipart';
      const args = ['-s', '--max-time', '5'];
      for (let i = 1; i < parsed.length - 1; i++) {
        let a = parsed[i];
        if (isMultipart && /=@/.test(a)) a = a.replace(/=@.*/, '=replay-inline');
        args.push(a);
      }
      args.push(parsed[parsed.length - 1]);

      const proc = await new Deno.Command('curl', {
        args,
        stdin: 'null',
        stdout: 'null',
        stderr: 'piped',
      }).output();
      assertEquals(
        proc.code,
        0,
        `${name}: curl 退出码 ${proc.code}，stderr: ${dec.decode(proc.stderr)}`,
      );
      const received = receivedQueue.shift();
      if (received === undefined) throw new Error(`${name}: 回显服务器未收到请求`);

      if (isMultipart) {
        // boundary 由 curl 重新生成，body 必然不同：只校验请求行 + CT 形态
        const head = dec.decode(received).split('\r\n\r\n')[0];
        const lines = head.split('\r\n');
        assertEquals(lines[0], 'POST /upload HTTP/1.1', name);
        assert(
          lines.some((l) => /^content-type: multipart\/form-data; boundary=/i.test(l)),
          `${name}: 缺少 multipart Content-Type`,
        );
      } else {
        assertEquals(normalizeWire(received), normalizeWire(enc.encode(raw)), name);
      }
    }
  } finally {
    listener.close();
    await server;
  }
});
