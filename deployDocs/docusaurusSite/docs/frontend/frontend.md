---
sidebar_position: 10
title: 第 2 章 · 前端（desktop + 5 个 provider）
description: frontend/ monorepo 的 dev 开发模式、release 构建、Docker 镜像打包 —— 全部可在 Mac M 芯片原生完成
---

# 第 2 章 · 前端（frontend/，Mac 原生构建 ✅）

**源码路径**：`frontend/`（pnpm monorepo：`desktop` + `providers/{applaunchpad,dbprovider,costcenter,template,license}` + `packages/*` 共享库）

**构建平台结论**：dev 与 release 产物构建均可在 Mac M 芯片 **原生完成**（Node 20.20.2 / pnpm 8.9.0 / prisma / sharp 均有 darwin-arm64 支持）。Docker 镜像构建在 M 芯片上推荐 `linux/arm64` 原生构建；`frontend/Makefile` 硬编码 `--platform=linux/amd64`，本文给出两种写法。

**版本要求**：Node `20.20.2`（`frontend/.nvmrc`），pnpm `8.9.0`。先按 [环境准备](/docs/intro/prerequisites) 装好。

---

## 第一部分：如何运行 Dev 开发模式

### 2.1 安装依赖（一次性，约 5-10 分钟）

```bash
cd $SEALOS_ROOT/frontend
nvm use 20.20.2          # 确认 node -v 是 v20.20.2
corepack enable
corepack prepare pnpm@8.9.0 --activate

pnpm install
```

说明（0 基础也要懂）：
- `preinstall` 脚本强制只能用 pnpm（npm/yarn 会被拒绝）；
- `postinstall` 会自动执行 `gen:theme-typings`（生成 Chakra UI 主题类型）和 `build-packages`（**先把 `packages/*` 共享库全部构建一遍**，provider/desktop 的 dev 与 build 都依赖它们）；
- `prepare` 会把仓库根的 husky 钩子装到 `frontend/.husky`（若报错可忽略，不影响构建）。

### 2.2 配置环境变量

desktop 需要一个 `.env.local` 才能跑 dev：

```bash
cd $SEALOS_ROOT/frontend/desktop
cp .env.template .env.local
```

编辑 `frontend/desktop/.env.local`，最小可用配置（连官方云环境调试）：

```bash
SEALOS_CLOUD_DOMAIN="cloud.sealos.io"   # 你要连的后端云环境域名
NEXT_PUBLIC_SERVICE="/service/"
PUBLIC_URL="http://localhost:3000"
# 本地/自建环境时按需打开：
# MONGODB_URI="mongodb://user:pass@host:27017/sealos-auth?authSource=admin"
# JWT_SECRET="xxx"
# PASSWORD_SALT="xxx"
# KUBECONFIG="/path/to/kubeconfig"
```

各 provider 基本无需 env 即可 dev（license 有 `providers/license/.env.template` 可参考）。

### 2.3 启动 dev 服务

```bash
cd $SEALOS_ROOT/frontend

pnpm dev-desktop     # desktop 门户，  http://localhost:3000
pnpm dev-app         # applaunchpad，  http://localhost:3000（与 desktop 同端口，别同时开）
pnpm dev-db          # dbprovider
pnpm dev-cost        # costcenter，    http://localhost:3001（源码写死 --port 3001）
pnpm dev-template    # template
pnpm dev-license     # license
```

等终端出现 `✓ Ready in ...ms` 后用浏览器访问对应端口。修改源码热更新即时生效。

**调试要点**：
- 前端调用后端 API 的地址由 `packages/client-sdk/src/utils/kubernetes.ts` 决定：集群内用 `KUBERNETES_SERVICE_HOST`，本地 dev 走 `SEALOS_CLOUD_DOMAIN` 域名下的 `/kubernetes`、`/service/` 反向代理路由。所以本地 dev 想打通后端，要么指向官方 `cloud.sealos.io`，要么指向你按第 7 章自建的域名。
- provider 是通过 desktop 的 SDK（`packages/client-sdk`）集成的微前端应用，单独 dev 时可用 `NEXT_PUBLIC_MOCK_USER=true`（license 模板的写法）mock 用户跳过登录。

### 2.4 单独开发共享包

```bash
cd $SEALOS_ROOT/frontend
pnpm -r --filter ./packages/<包名> run dev     # 大多数包只有 build，改包后重跑 pnpm run build-packages
```

---

## 第二部分：如何构建 Release 产物

release 产物是 Next.js 的 **standalone 静态构建**（`.next/standalone` + `.next/static` + `public`）。

### 2.5 构建共享包（必须最先做）

```bash
cd $SEALOS_ROOT/frontend
pnpm run build-packages     # 构建全部 packages/*
```

### 2.6 构建全部应用

```bash
pnpm run build-providers    # 依次构建 5 个 provider（--workspace-concurrency=2）
pnpm --filter ./desktop run build   # 构建 desktop（如需连接自建环境，先配好 .env.production 或 .env.local）
```

### 2.7 产物归档到统一构建目录

把每个应用的 standalone 产物收集到 `$SEALOS_BUILD/frontend/<app>`：

```bash
cd $SEALOS_ROOT/frontend
for app in desktop providers/applaunchpad providers/dbprovider providers/costcenter providers/template providers/license; do
  name=$(basename $app)
  mkdir -p $SEALOS_BUILD/frontend/$name
  cp -r $app/.next/standalone $SEALOS_BUILD/frontend/$name/ 2>/dev/null
  cp -r $app/.next/static $SEALOS_BUILD/frontend/$name/standalone/$( [ "$name" != desktop ] && echo providers/ )$name/.next/ 2>/dev/null
done
```

> 说明：standalone 产物内目录结构与 `--build-arg path` 一致（provider 在 `providers/<name>` 下，desktop 在 `desktop/` 下）。若你只构建个别应用，按需调整。此归档主要为留档；真正打镜像走第三部分的 Dockerfile（它在容器内自己构建，不依赖本地归档）。

### 2.8（可选）用 Makefile 的非 Docker 构建

```bash
cd $SEALOS_ROOT/frontend
make build-packages                  # 内部等价 pnpm --offline ...
make build-providers/dbprovider      # 单独构建某个 provider
make build-desktop                   # 单独构建 desktop
```

---

## 第三部分：如何打包成 K8s 镜像

所有前端应用共用一个多阶段 Dockerfile：`frontend/Dockerfile`（node:20.20.2-alpine，deps→builder→runner，最终由 Node 直接运行 Next.js standalone，`EXPOSE 3000`，`ENTRYPOINT ["dumb-init","sh","-c","node ${launchpath}"]`）。

### 2.9 构建 arm64 镜像（M 芯片原生，推荐本地部署用）

```bash
cd $SEALOS_ROOT/frontend

# 一次性：构建依赖缓存层镜像（加速后续构建）
docker build --platform linux/arm64 --target deps -t sealos-deps:dev .

# 逐个构建（--build-arg 区分应用）
docker build --platform linux/arm64 \
  --build-arg path=desktop --build-arg name=desktop \
  -t sealos-dev/desktop-frontend:local .

for p in applaunchpad dbprovider costcenter template license; do
  docker build --platform linux/arm64 \
    --build-arg path=providers/$p --build-arg name=$p \
    -t sealos-dev/$p-frontend:local .
done
```

> 依赖缓存层加速技巧（可选）：给 builder 阶段复用 deps 层——Dockerfile 的多阶段结构本身已让 `deps` 层被缓存，重复构建只有 `builder/runner` 重跑。

### 2.10 构建 amd64 镜像（如目标集群是 x86 服务器）

即 `frontend/Makefile` 的原生行为（它写死了 `--platform=linux/amd64`）：

```bash
cd $SEALOS_ROOT/frontend
make all IMAGE_TAG=local            # 构建全部 6 个应用（镜像名 sealos-<name>:local）
# 或单个：
make image-build-providers/dbprovider IMAGE_TAG=local
make image-build-desktop IMAGE_TAG=local
```

M 芯片上会经 Rosetta/QEMU 模拟构建，耗时明显更长。也可手写等价命令：

```bash
docker build --platform linux/amd64 \
  --build-arg path=providers/dbprovider --build-arg name=dbprovider \
  -t sealos-dev/dbprovider-frontend:local .
```

### 2.11 导出镜像 tar 到统一产物目录

```bash
mkdir -p $SEALOS_BUILD/images
for img in desktop-frontend applaunchpad-frontend dbprovider-frontend costcenter-frontend template-frontend license-frontend; do
  docker save sealos-dev/$img:local -o $SEALOS_BUILD/images/$img-arm64.tar
done
ls -lh $SEALOS_BUILD/images/
```

### 2.12 验证镜像可运行

```bash
docker run --rm -p 3000:3000 sealos-dev/dbprovider-frontend:local
# 另开终端：
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000   # 期望 200/3xx
```

### 2.13 推送（可选，多节点集群需要仓库）

```bash
docker tag sealos-dev/desktop-frontend:local <你的registry>/sealos-dev/desktop-frontend:local
docker push <你的registry>/sealos-dev/desktop-frontend:local
```

---

## 本章产出清单

| 产物 | 位置 |
| --- | --- |
| 6 个前端镜像 | 本地 Docker（`sealos-dev/<app>-frontend:local`） |
| 镜像 tar | `$SEALOS_BUILD/images/<app>-frontend-arm64.tar` |
| standalone 留档 | `$SEALOS_BUILD/frontend/<app>/standalone/` |
