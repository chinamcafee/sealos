---
sidebar_position: 40
title: 第 5 章 · Webhook（webhooks/，Mac 原生构建 ✅）
description: admission 与 stargz 两个 webhook 的 dev 调试、release 构建、镜像打包
---

# 第 5 章 · Webhook（webhooks/，Mac 原生构建 ✅）

**源码路径**：`webhooks/admission`（准入 webhook，标准 kubebuilder）、`webhooks/stargz`（容器运行时 stargz 懒加载注入 webhook）。Go workspace：`webhooks/go.work`（Go 1.24.6）。

两者均为 `CGO_ENABLED=0` 纯 Go，构建方式与第 3 章控制器几乎一致，本章按差异点描述。

| 模块 | 入口 | 镜像（IMG 默认） | 特点 |
| --- | --- | --- | --- |
| admission | `go run ./main.go` | `ghcr.io/labring/sealos-admission-webhook` | 有完整 kubebuilder `config/`（含 certmanager、webhook），有 `deploy/` manifests |
| stargz | `go run ./cmd/main.go` | `ghcr.io/labring/sealos/stargz-webhook` | Dockerfile 为容器内编译（golang:1.24），有 lint / kind e2e target |

---

## 第一部分：如何运行 Dev 开发模式

### 5.1 admission-webhook

复用第 3 章的 kind 集群，并装好 cert-manager（webhook 需要 CA 签发证书）：

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl -n cert-manager wait --for=condition=Available deploy --all --timeout=300s

cd $SEALOS_ROOT/webhooks/admission
make install     # 安装 CRD（如该模块定义了 CRD）
make run         # = manifests generate fmt vet && go run ./main.go
```

webhook 本地跑的完整链路（ValidatingWebhookConfiguration 指向集群 Service，Service 需 port-forward 回本机）开发成本较高，日常建议直接 `make docker-build` + `make deploy` 在 kind 里迭代：

```bash
make docker-build IMG=sealos-dev/admission-webhook:local TARGETARCH=arm64
kind load docker-image sealos-dev/admission-webhook:local --name sealos-dev
make deploy IMG=sealos-dev/admission-webhook:local
kubectl -n admission-webhook-system get pods
```

### 5.2 stargz-webhook

```bash
cd $SEALOS_ROOT/webhooks/stargz
make run                     # go run ./cmd/main.go
make lint                    # golangci-lint（版本 v2.5.0，未装会自动下载）
make test-e2e                # 可选：用 kind 起 e2e 集群（KIND_CLUSTER ?= stargz-runtime-injector-test-e2e）
```

---

## 第二部分：如何构建 Release 产物

### 5.3 admission（预编译二进制模式）

```bash
cd $SEALOS_ROOT/webhooks/admission
GOARCH=arm64 make build                 # 产物 bin/manager（linux/arm64）
mkdir -p $SEALOS_BUILD/webhooks/admission
cp bin/manager $SEALOS_BUILD/webhooks/admission/manager-linux-arm64
```

### 5.4 stargz（Makefile / 手工 go build 均可）

stargz 的 `build` target 与 Dockerfile 均为容器内编译，但 CGO=0 所以本地交叉编译同样可行：

```bash
cd $SEALOS_ROOT/webhooks/stargz
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o bin/stargz-webhook ./cmd/main.go
mkdir -p $SEALOS_BUILD/webhooks/stargz
cp bin/stargz-webhook $SEALOS_BUILD/webhooks/stargz/stargz-webhook-linux-arm64
```

---

## 第三部分：如何打包成 K8s 镜像

### 5.5 admission（COPY 二进制 + distroless）

```bash
cd $SEALOS_ROOT/webhooks/admission
make docker-build IMG=sealos-dev/admission-webhook:local TARGETARCH=arm64
docker save sealos-dev/admission-webhook:local -o $SEALOS_BUILD/images/admission-webhook-arm64.tar
```

### 5.6 stargz（官方多阶段 Dockerfile，容器内编译）

```bash
cd $SEALOS_ROOT/webhooks/stargz
docker build --platform linux/arm64 -t sealos-dev/stargz-webhook:local .

# 或用本地预编译二进制快速打包：
cat > Dockerfile.local <<'EOF'
FROM gcr.io/distroless/static:nonroot
COPY bin/stargz-webhook /stargz-webhook
USER 65532:65532
ENTRYPOINT ["/stargz-webhook"]
EOF
docker build -f Dockerfile.local -t sealos-dev/stargz-webhook-fast:local .
docker save sealos-dev/stargz-webhook:local -o $SEALOS_BUILD/images/stargz-webhook-arm64.tar
```

### 5.7 部署形态参考

admission 有 `webhooks/admission/deploy/`（Kubefile + manifests）；stargz 无 deploy 目录（它属于节点运行时增强，全量部署章节按需选装）。

---

## 本章产出清单

| 产物 | 位置 |
| --- | --- |
| admission/stargz linux 二进制 | `$SEALOS_BUILD/webhooks/<mod>/` |
| 2 个 webhook 镜像 | 本地 Docker（`sealos-dev/<mod>(-webhook):local`） |
| 镜像 tar | `$SEALOS_BUILD/images/` |
