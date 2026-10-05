---
sidebar_position: 50
title: 第 6 章 · sealos CLI（lifecycle/，必须 Docker Linux 容器 ❌Mac 原生）
description: sealos/sealctl/sreg 为 CGO_ENABLED=1 + 静态链接（btrfs/gpgme/devmapper），必须在 Linux 容器内构建；lvscare/image-cri-shim 为纯 Go
---

# 第 6 章 · sealos CLI（lifecycle/，必须 Linux 容器构建 ❌）

**源码路径**：`lifecycle/`（Go 1.23 workspace，含 `cmd/{sealos,sealctl,lvscare,image-cri-shim,sreg}` 与 `staging/` 下的 image-cri-shim、lvscare 子模块）。

**为什么 Mac 原生编不了（依据源码核实，不是猜测）**：

- `lifecycle/scripts/make-rules/golang.mk` 中 `sealos`、`sealctl` 两个二进制强制 `CGO_ENABLED=1`，且要求 `aarch64-linux-gnu-gcc` / `x86_64-linux-gnu-gcc` 交叉编译器；
- `lifecycle/.goreleaser.yml` 对 `sealos/sealctl/sreg` 使用 `-extldflags '-static --static'` 静态链接，依赖 Linux 的 `libbtrfs`、`libgpgme`、`libdevmapper` C 库；
- 官方 `lifecycle/Dockerfile` 就是为此存在：`golang:1-bullseye` + 安装上述 C 库与交叉编译器后执行 `make`。
- 例外：`lvscare`、`image-cri-shim` 为 `CGO_ENABLED=0`，理论上 Mac 可交叉编译（命令在 6.5 给出）。

产物路径（`make build` 规则）：`lifecycle/bin/<linux>_<arch>/<命令>`（如 `lifecycle/bin/linux_arm64/sealos`）。

**平台选择**：容器不必是 x86_64 —— M 芯片上 `golang:1-bullseye` 的 **arm64 容器原生运行**，可直接产出 `linux/arm64` 二进制（速度最快）；需要 `linux/amd64` 产物时加 `--platform linux/amd64`（QEMU/Rosetta 模拟，慢）。两种命令都给出。

按本指南约定：**Docker 工作目录挂载源码、产物目录挂载 `$SEALOS_BUILD/lifecycle`**。

---

## 第一部分：如何运行 Dev 开发模式

sealos CLI 是命令行工具，"dev 模式" = 在容器里编译 → 拿二进制出来 → 直接跑。

### 6.1 一次性准备：构建专用开发容器镜像（含全部 C 库与交叉工具链）

```bash
cd $SEALOS_ROOT/lifecycle
docker build --platform linux/arm64 -t sealos-lifecycle-dev:arm64 - <<'EOF'
FROM golang:1.23-bullseye
RUN apt-get update && apt-get install -y --no-install-recommends \
    make git ca-certificates \
    libbtrfs-dev libgpgme-dev libdevmapper-dev \
    gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
    gcc-x86-64-linux-gnu libc6-dev-amd64-cross \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
EOF
```

> 官方 `lifecycle/Dockerfile` 只装了 arm64 交叉工具链（它默认在 amd64 容器里跑）；上面这个开发镜像同时装了双架构工具链，且 base 与官方一致（`golang:1.x-bullseye`）。

### 6.2 在容器里编译 sealos（arm64，最快）

```bash
docker run --rm \
  -v $SEALOS_ROOT:/src \
  -v $SEALOS_BUILD/lifecycle:/out \
  -w /src/lifecycle \
  sealos-lifecycle-dev:arm64 \
  bash -c "make build BINS=sealos && cp bin/linux_arm64/sealos /out/sealos-linux-arm64"
```

参数解释（0 基础）：`make build BINS=sealos` 只编译 sealos 一个二进制；`PLATFORM` 默认取 `linux_$(go env GOARCH)`，arm64 容器里即 `linux_arm64`；产物从容器内 `bin/linux_arm64/` 拷到挂载出的 `/out`（= 宿主机 `$SEALOS_BUILD/lifecycle`）。

### 6.3 编译 amd64 版（在 arm64 容器内交叉编译，比 QEMU x86 容器快）

```bash
docker run --rm \
  -v $SEALOS_ROOT:/src \
  -v $SEALOS_BUILD/lifecycle:/out \
  -w /src/lifecycle \
  sealos-lifecycle-dev:arm64 \
  bash -c "make build BINS=sealos PLATFORM=linux_amd64 && cp bin/linux_amd64/sealos /out/sealos-linux-amd64"
```

`golang.mk` 会自动选 `x86_64-linux-gnu-gcc` 作为交叉 CC（开发镜像里已装）。

### 6.4 运行 / 调试

Mac 上不能直接运行 Linux ELF。两种调试方式：

```bash
# 方式 A：容器内直接跑（--platform 与产物架构一致）
docker run --rm -it \
  -v $SEALOS_ROOT:/src -v $SEALOS_BUILD/lifecycle:/out \
  -w /src/lifecycle \
  sealos-lifecycle-dev:arm64 \
  bash    # 进入容器后: /out/sealos-linux-arm64 version; go test ./pkg/... ; 改码后重跑 6.2

# 方式 B（开发体验最好）：纯 Go 子命令在 Mac 上直接调试
cd $SEALOS_ROOT/lifecycle
go run ./cmd/sealos version 2>&1 | head   # 能跑的纯 Go 逻辑可直接 go run / IDE 断点
go test ./pkg/...
```

> 说明：`go run ./cmd/sealos` 在 Mac 上通常可执行大部分不涉及 CGO 路径的子命令（`version`、`gen`、`docs` 等），涉及容器存储/镜像挂载的逻辑才需要 Linux。真机验证用方式 A。

### 6.5 纯 Go 子命令（lvscare / image-cri-shim，Mac 可直接编译）

```bash
cd $SEALOS_ROOT/lifecycle
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o $SEALOS_BUILD/lifecycle/lvscare-linux-arm64 ./cmd/lvscare
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o $SEALOS_BUILD/lifecycle/image-cri-shim-linux-arm64 ./cmd/image-cri-shim
```

---

## 第二部分：如何构建 Release 产物

### 6.6 全部 5 个二进制（arm64 + amd64 双架构）

```bash
docker run --rm \
  -v $SEALOS_ROOT:/src \
  -v $SEALOS_BUILD/lifecycle:/out \
  -w /src/lifecycle \
  sealos-lifecycle-dev:arm64 \
  bash -c "set -e
    make build.multiarch BINS='sealos sealctl lvscare image-cri-shim sreg'
    mkdir -p /out/release
    cp -r bin/* /out/release/"

find $SEALOS_BUILD/lifecycle/release -type f
# 预期：linux_amd64/ 和 linux_arm64/ 下各有 5 个二进制
```

### 6.7 goreleaser 完整发布产物（可选，与官方 release.yml 一致）

官方 `release.yml` 用 goreleaser 产出 tar.gz/deb/rpm/镜像/checksum。本地复刻（**必须 x86_64 或 arm64 Linux 容器，goreleaser 只发 Linux 产物**）：

```bash
docker run --rm \
  -v $SEALOS_ROOT:/src -v $SEALOS_BUILD/lifecycle:/out \
  -w /src/lifecycle \
  sealos-lifecycle-dev:arm64 \
  bash -c "set -e
    go install github.com/goreleaser/goreleaser/v2@latest
    goreleaser release --snapshot --clean --skip=publish,validate
    cp -r dist /out/goreleaser-dist 2>/dev/null || true"
```

> `--snapshot` 只构建不发布；产物在容器内 `dist/`，已拷出到 `$SEALOS_BUILD/lifecycle/goreleaser-dist`（含 tar.gz、checksums.txt、docker 构建上下文等）。

### 6.8 打包 tar 留档

```bash
cd $SEALOS_BUILD/lifecycle
tar -czf sealos-cli-linux-arm64.tar.gz -C release/linux_arm64 .
ls -lh $SEALOS_BUILD/lifecycle
```

---

## 第三部分：如何打包成 K8s 镜像

sealos CLI 本身不是跑在 K8s 里的组件，但官方把它打成两类镜像：**CLI 工具镜像**（供在容器里执行 sealos 命令、CI 构建集群镜像用）和 goreleaser 的 `docker buildx` 镜像。本地等价做法：

### 6.9 用官方 lifecycle/Dockerfile 构建镜像

官方 Dockerfile（`golang:1-bullseye` builder + `make ${ACTION}`，默认 `build-pack`）就是"镜像形态的完整构建"：

```bash
cd $SEALOS_ROOT/lifecycle
docker build --platform linux/arm64 -t sealos-dev/sealos-cli:local .
docker save sealos-dev/sealos-cli:local -o $SEALOS_BUILD/images/sealos-cli-arm64.tar
```

### 6.10 用 6.6 的二进制打轻量工具镜像（推荐，快）

```bash
docker build --platform linux/arm64 \
  -t sealos-dev/sealos-cli:local \
  $SEALOS_BUILD/lifecycle/release/linux_arm64 \
  -f- <<'EOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bash socat iptables && rm -rf /var/lib/apt/lists/*
COPY sealos /usr/bin/sealos
COPY sealctl /usr/bin/sealctl
COPY sreg /usr/bin/sreg
ENTRYPOINT ["sealos"]
EOF
docker save sealos-dev/sealos-cli:local -o $SEALOS_BUILD/images/sealos-cli-arm64.tar
```

### 6.11 用容器里的 sealos 构建集群镜像（第 7 章会用）

集群镜像构建（`sealos build -f Kubefile`）需要在能访问宿主 Docker 的环境跑 sealos。最简单方式是直接把二进制取出来在 Mac 宿主跑：

```bash
cp $SEALOS_BUILD/lifecycle/release/linux_arm64/sealos /usr/local/bin/sealos 2>/dev/null \
  || sudo cp $SEALOS_BUILD/lifecycle/release/linux_arm64/sealos /usr/local/bin/sealos
```

> sealos 二进制是 **Linux ELF，Mac 宿主跑不了**。在 Mac 上构建集群镜像请改用官方 release 版 sealos（环境准备章方式 A 安装的 darwin 版），或用容器方式（挂载 `/var/run/docker.sock`）：

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  -v $SEALOS_ROOT:/src -v $SEALOS_BUILD/cluster-images:/out -w /src \
  sealos-dev/sealos-cli:local build -f Kubefile -t xxx .
```

（实际集群镜像构建流程见第 7 章。）

---

## 本章产出清单

| 产物 | 位置 |
| --- | --- |
| 5 个 CLI 二进制（双架构） | `$SEALOS_BUILD/lifecycle/release/{linux_arm64,linux_amd64}/` |
| goreleaser 快照产物 | `$SEALOS_BUILD/lifecycle/goreleaser-dist/` |
| sealos CLI 工具镜像 | 本地 Docker + `$SEALOS_BUILD/images/sealos-cli-arm64.tar` |
