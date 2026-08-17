# ---- 构建阶段：用 Deno + esbuild 把 convert.ts 打包成前端模块 ----
# Deno 2.x 移除了 `deno bundle`，改用 esbuild（通过 npm: 指定符运行）。
FROM denoland/deno:2.1.4 AS builder

WORKDIR /app
COPY convert.ts .

# 预拉取 esbuild，并把核心模块打包成 ESM
RUN deno cache npm:esbuild@0.24.0 \
 && mkdir -p _build \
 && deno run --allow-read --allow-write --allow-env --allow-run \
      npm:esbuild@0.24.0 convert.ts --bundle --format=esm \
      --outfile=_build/convert.mjs

# ---- 运行阶段：nginx 托管静态文件 ----
FROM nginx:1.27.2-alpine

# 清空默认页面，并确保 .mjs 返回正确的 JS MIME 类型（ES module 必需）。
# 默认 mime.types 已有 application/javascript -> js，这里把 mjs 追加上去；
# 若默认配置发生变化（找不到该行），fallback 追加一个独立 types 块。
RUN rm -rf /usr/share/nginx/html/* \
 && sed -i 's|application/javascript\(.*\)js;|application/javascript\1js mjs;|' /etc/nginx/mime.types \
 && grep -q 'application/javascript.*mjs' /etc/nginx/mime.types \
 || { echo 'types { application/javascript mjs; }' >> /etc/nginx/mime.types; }

COPY index.html style.css /usr/share/nginx/html/
COPY --from=builder /app/_build/convert.mjs /usr/share/nginx/html/_build/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
