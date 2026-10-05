---
sidebar_position: 30
title: 第 4 章 · 后端服务（service/，Mac 原生构建 ✅）
description: account/database/launchpad/vlogs 四个 Go 服务的 dev 调试、release 构建、镜像打包（注意构建上下文是仓库根）
---

# 第 4 章 · 后端服务（service/，Mac 原生构建 ✅）

**源码路径**：`service/account`、`service/database`、`service/launchpad`、`service/vlogs`（+ 公共库 `service/pkg`）。Go workspace：`service/go.work`（Go 1.25），通过 replace 直接引用 `../controllers` 源码。

**关键差异（与控制器相比）**：
- service 的 Dockerfile 是 **多阶段容器内编译**（`golang:1.25-alpine` builder + distroless runtime，`EXPOSE 9090`），且 **构建上下文是仓库根目录**（要同时 COPY `service/` 和 `controllers/`）；
- 但由于 `CGO_ENABLED=0`，你依然可以在 Mac 上 `go build` 出 Linux 二进制；镜像两种打法都行（本地预编译二进制法 / 官方 Dockerfile 法），本指南都给出。

四个服务的 Makefile 结构相同：变量 `GOOS=linux`、`CGO_ENABLED=0`、`GO_BUILD_FLAGS=-trimpath -ldflags "-s -w"`，target 有 `build`、`docker-build`（`docker build --platform linux/$(TARGETARCH) -t $(IMG) -f Dockerfile ../..`）、`docker-buildx-push`。

---

## 第一部分：如何运行 Dev 开发模式

service 是 HTTP API 服务，没有 `make run` target，直接 `go run main.go`。它们大多依赖 K8s API 与数据库连接，本地调试方式：

### 4.1 准备依赖

- 一个可用的 k8s 集群（第 3 章的 kind 集群即可），kubeconfig 指向它；
- 按第 7 章先装好的 MongoDB / CockroachDB（或暂时指向官方云的数据库）。

### 4.2 直接运行（以 account-service 为例）

```bash
cd $SEALOS_ROOT/service/account
go run main.go
# 默认监听 :9090（Dockerfile EXPOSE 9090），具体 env/config 见 main.go 与 deploy/ 目录
```

### 4.3 配置来源

- `service/vlogs`、`service/launchpad` 有 `config.yml` 配置文件（读取路径一般由 env 指定），dev 时直接改仓库内配置；
- `service/account` 以环境变量 + K8s 内 ConfigMap（`sealos-system` 命名空间的 `sealos-config`）为主，本地跑时先 `export` 对应 env。可以先看入口文件确认：

```bash
cd $SEALOS_ROOT/service/account && head -80 main.go
```

### 4.4 部署形态下的 dev（迭代最快的方式）

把服务以 `kubectl port-forward` + 集群 Deployment 的方式调试：

```bash
kubectl -n sealos-system port-forward deploy/account-service 9090:9090
curl http://127.0.0.1:9090/healthz   # 探活（以实际路由为准）
```

---

## 第二部分：如何构建 Release 产物

### 4.5 Mac 原生交叉编译（CGO=0，无障碍）

```bash
cd $SEALOS_ROOT/service/account
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -tags=jsoniter -ldflags "-s -w" -trimpath -o bin/manager main.go
file bin/manager    # ELF aarch64
```

> `-tags=jsoniter` 是官方构建使用的 gin JSON 加速 tag（account-service Dockerfile 同款），database/launchpad/vlogs 可不带。

四个服务一键构建并归档：

```bash
for m in account database launchpad vlogs; do
  (cd $SEALOS_ROOT/service/$m && \
   CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o bin/manager main.go && \
   mkdir -p $SEALOS_BUILD/services/$m && cp bin/manager $SEALOS_BUILD/services/$m/manager-linux-arm64)
done
```

### 4.6 官方 Makefile 方式

```bash
cd $SEALOS_ROOT/service/account
make build      # CGO_ENABLED=0 GOOS=linux go build ... -o bin/manager main.go
```

（产物为宿主 GOARCH 的 Linux 二进制；M 芯片上即 arm64。）

---

## 第三部分：如何打包成 K8s 镜像

### 4.7 方式 A：官方 Dockerfile（容器内编译，最忠实于 CI）

```bash
cd $SEALOS_ROOT/service/account
make docker-build IMG=sealos-dev/account-service:local TARGETARCH=arm64
# 等价于：docker build --platform linux/arm64 -t sealos-dev/account-service:local -f Dockerfile ../..
```

**注意 `-f Dockerfile ../..`：构建上下文必须是仓库根**，否则容器内找不到 `controllers/` 源码会编译失败——这就是为什么必须在 `service/<mod>` 目录里执行、或在根目录执行时写对相对路径：

```bash
# 也可以在仓库根手动执行（等价）：
cd $SEALOS_ROOT
docker build --platform linux/arm64 \
  -f service/account/Dockerfile \
  -t sealos-dev/account-service:local .
```

四个服务全部构建：

```bash
for m in account database launchpad vlogs; do
  (cd $SEALOS_ROOT/service/$m && \
   make docker-build IMG=sealos-dev/$m-service:local TARGETARCH=arm64)
done
```

amd64 镜像：加 `GOARCH=amd64`（本地预编译路径）或 `--platform linux/amd64`（容器内编译路径，M 芯片上 QEMU 模拟、较慢）。

### 4.8 方式 B：本地预编译二进制 + 极简 Dockerfile（速度最快）

利用 4.5 的产物，临时写一个 `Dockerfile.local`：

```bash
cd $SEALOS_ROOT/service/account
cat > Dockerfile.local <<'EOF'
FROM gcr.io/distroless/static:nonroot
WORKDIR /
COPY bin/manager /manager
EXPOSE 9090
USER 65532:65532
ENTRYPOINT ["/manager"]
EOF
docker build -f Dockerfile.local -t sealos-dev/account-service-fast:local .
```

### 4.9 导出镜像 tar

```bash
for m in account database launchpad vlogs; do
  docker save sealos-dev/$m-service:local -o $SEALOS_BUILD/images/$m-service-arm64.tar
done
```

### 4.10 部署形态参考

`service/<mod>/deploy/` 下有官方 manifests/charts（`service/database/deploy/manifests/deploy.yaml` 可直接 `kubectl apply`；account 是 charts + entrypoint.sh），第 7 章统一使用。

---

## 本章产出清单

| 产物 | 位置 |
| --- | --- |
| 4 个服务 linux 二进制 | `$SEALOS_BUILD/services/<mod>/manager-linux-arm64` |
| 4 个服务镜像 | 本地 Docker（`sealos-dev/<mod>-service:local`） |
| 镜像 tar | `$SEALOS_BUILD/images/<mod>-service-arm64.tar` |
