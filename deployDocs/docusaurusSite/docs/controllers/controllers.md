---
sidebar_position: 20
title: 第 3 章 · Kubernetes 控制器（controllers/，Mac 原生构建 ✅）
description: 8 个控制器的 dev 调试（make run / kind 集群 / CRD / webhook 证书）、release 交叉编译、distroless 镜像打包
---

# 第 3 章 · Kubernetes 控制器（controllers/，Mac 原生构建 ✅）

**源码路径与入口差异**（先记住这张表，命令里会用到）：

| 模块 | 源码路径 | 入口（`make run` 实际执行） | Dockerfile 内二进制名 | 含 webhook/cert-manager |
| --- | --- | --- | --- | --- |
| user | `controllers/user` | `go run ./main.go` | `bin/manager`（构建时重命名为 arch 后缀） | 是 |
| account | `controllers/account` | `go run ./main.go` | `bin/controller-account-<arch>` | 是 |
| app | `controllers/app` | `go run ./cmd/main.go` | `bin/manager` | 否 |
| license | `controllers/license` | `go run ./cmd/manager/main.go` | `bin/manager` | 否 |
| node | `controllers/node` | `go run ./main.go` | `bin/manager` | 否 |
| resources | `controllers/resources` | `go run ./main.go` | `bin/manager` | 否 |
| job-init | `controllers/job/init` | `go run ./cmd/preset/main.go` | `bin/preset-<arch>`→`bin/manager` | 否 |
| job-heartbeat | `controllers/job/heartbeat` | `go run ./cmd/main.go` | `bin/heartbeat-<arch>`→`bin/manager` | 否 |

公共事实：
- 全部模块 `CGO_ENABLED=0`，Makefile 写死 `GOOS=linux`，**Mac M 芯片可原生交叉编译出 Linux 产物**；
- Dockerfile 均为 `gcr.io/distroless/static:nonroot` 单阶段，`COPY` 预编译二进制（即"先 make build 再 docker build"两步式，不是容器内编译）；
- Go workspace：`controllers/go.work`（Go 1.25），在 `controllers/` 目录下执行 go 命令即可感知全部模块。

下文以 **user** 为示范模块；其他模块把路径/名字替换即可（差异处单独标注）。

---

## 第一部分：如何运行 Dev 开发模式

### 3.1 准备一个本地集群（kind）

```bash
cat > /tmp/kind-sealos.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: sealos-dev
nodes:
  - role: control-plane
EOF
kind create cluster --config /tmp/kind-sealos.yaml
kubectl get nodes   # STATUS 应为 Ready
```

### 3.2 安装 CRD 与 RBAC（kubebuilder 脚手架方式）

```bash
cd $SEALOS_ROOT/controllers/user

# 自动下载 kustomize/controller-gen 到 ~/go/bin（首次约 1-2 分钟）
make install      # = kustomize build config/crd | kubectl apply -f -
kubectl get crd | grep -Ei "user|account"   # 验证 CRD 已创建
```

> 含 webhook 的模块（user、account）开发期建议**先不在本地跑 webhook 服务**，只跑 controller 逻辑：`make run` 启动的 manager 会尝试起 webhook 端口，若 CRD 的 webhook 配置指向集群内服务而本地没有证书，调谐不受影响但 webhook 会报错。规范做法见 3.4。

### 3.3 本地运行控制器

```bash
cd $SEALOS_ROOT/controllers/user
make run          # = manifests generate fmt vet 后 go run ./main.go
```

`make run` 直接使用你当前 kubectl 上下文（kind 集群）的 `~/.kube/config`。终端会持续输出 controller-runtime 日志；`Ctrl + C` 退出。

其他模块：

```bash
cd $SEALOS_ROOT/controllers/app      && make run    # go run ./cmd/main.go
cd $SEALOS_ROOT/controllers/license  && make run    # go run ./cmd/manager/main.go
cd $SEALOS_ROOT/controllers/job/init && make run    # go run ./cmd/preset/main.go
cd $SEALOS_ROOT/controllers/job/heartbeat && make run
cd $SEALOS_ROOT/controllers/{account,node,resources} && 均为 go run ./main.go
```

### 3.4 webhook 本地调试（user/account）

标准 kubebuilder 流程（集群内装 cert-manager，webhook 走集群 Deployment；本地只调 controller 时可跳过）：

```bash
# 集群装 cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl -n cert-manager wait --for=condition=Available deploy --all --timeout=300s

cd $SEALOS_ROOT/controllers/user
kustomize build config/default | kubectl apply -f -   # 部署 Deployment + Service + webhook 配置
```

想本地断点调 webhook：先构建镜像并 `make deploy IMG=<镜像>` 让 webhook 走集群，控制器逻辑部分再用 `make run` 本地跑（把 `config/default` 中 webhook 部分与 manager 部分拆开 apply）。

### 3.5 提交 CR 触发调谐验证

```bash
kubectl apply -f $SEALOS_ROOT/controllers/user/config/samples/*.yaml
kubectl get <CR类型> -A   # 在 make run 终端观察 reconcile 日志
```

### 3.6 单元测试

```bash
cd $SEALOS_ROOT/controllers/user
make test    # go test -race ./... -count=1
```

---

## 第二部分：如何构建 Release 产物

`make build` 写死 `GOOS=linux` 且 `CGO_ENABLED=0`，在 Mac 上直接交叉编译：

### 3.7 构建 linux/arm64 二进制（M 芯片本机架构，本地 kind 部署用）

```bash
cd $SEALOS_ROOT/controllers/user
GOARCH=arm64 make build          # 产物：bin/manager（linux/arm64）
file bin/manager                 # 应显示 ELF 64-bit LSB executable, ARM aarch64
```

> Go 的目标架构优先读环境变量 `GOARCH`，所以 `GOARCH=arm64 make build` 即可（M 芯片上 `go env GOARCH` 本来就是 arm64，此处显式写出是为了可复制到 Intel 机器）。

### 3.8 构建 linux/amd64 二进制（目标为 x86 集群时）

```bash
cd $SEALOS_ROOT/controllers/user
GOARCH=amd64 make build          # 纯 Go 交叉编译，无需任何工具链
```

### 3.9 归档到统一产物目录

```bash
MODS="user account app license node resources"
for m in $MODS; do
  (cd $SEALOS_ROOT/controllers/$m && GOARCH=arm64 make build && \
   mkdir -p $SEALOS_BUILD/controllers/$m && cp bin/manager $SEALOS_BUILD/controllers/$m/manager-linux-arm64)
done
(cd $SEALOS_ROOT/controllers/job/init && GOARCH=arm64 make build && \
 mkdir -p $SEALOS_BUILD/controllers/job-init && cp bin/manager $SEALOS_BUILD/controllers/job-init/preset-linux-arm64)
(cd $SEALOS_ROOT/controllers/job/heartbeat && GOARCH=arm64 make build && \
 mkdir -p $SEALOS_BUILD/controllers/job-heartbeat && cp bin/manager $SEALOS_BUILD/controllers/job-heartbeat/heartbeat-linux-arm64)
```

> account 的 `docker-build` 会把 `bin/manager` 改名成 `bin/controller-account-<arch>`，我们手工归档保持原名即可，Dockerfile 打镜像时用 `--build-arg TARGETARCH` 自动匹配。

---

## 第三部分：如何打包成 K8s 镜像

Dockerfile 是 "COPY 预编译二进制 + distroless" 模式，因此 **镜像构建也完全可以在 Mac 上完成**（docker 只是打包层，不做编译）。

### 3.10 make docker-build（一步到位）

```bash
cd $SEALOS_ROOT/controllers/user
make docker-build IMG=sealos-dev/user-controller:local TARGETARCH=arm64
# 内部执行：GOOS=linux 的 go build（本机 arm64）→ mv bin/manager → docker build --build-arg TARGETARCH=arm64

docker images | grep sealos-dev
```

构建 amd64 镜像（M 芯片上交叉编译 + 打 amd64 层）：

```bash
cd $SEALOS_ROOT/controllers/user
GOARCH=amd64 make docker-build IMG=sealos-dev/user-controller:local TARGETARCH=amd64
```

### 3.11 全部 8 个控制器一键构建脚本（arm64）

```bash
declare -A M=( [user]=user [account]=account [app]=app [license]=license [node]=node [resources]=resources )
for m in "${!M[@]}"; do
  (cd $SEALOS_ROOT/controllers/$m && \
   make docker-build IMG=sealos-dev/$m-controller:local TARGETARCH=arm64)
done
(cd $SEALOS_ROOT/controllers/job/init && \
 make docker-build IMG=sealos-dev/job-init-controller:local TARGETARCH=arm64)
(cd $SEALOS_ROOT/controllers/job/heartbeat && \
 make docker-build IMG=sealos-dev/job-heartbeat-controller:local TARGETARCH=arm64)
```

### 3.12 导出镜像 tar

```bash
for img in user account app license node resources job-init job-heartbeat; do
  docker save sealos-dev/$img-controller:local -o $SEALOS_BUILD/images/$img-controller-arm64.tar
done
```

### 3.13 在 kind 集群里用 kubebuilder 脚手架快速验证（开发路径）

```bash
kind load docker-image sealos-dev/user-controller:local --name sealos-dev
cd $SEALOS_ROOT/controllers/user
make deploy IMG=sealos-dev/user-controller:local
kubectl -n user-system get pods   # 等 Running
kubectl -n user-system logs deploy/user-controller | head
```

### 3.14 真实部署形态：Helm chart（生产路径，第 7 章使用）

每个控制器 `deploy/` 目录下是官方真实发布物（Kubefile + Helm chart）：

```bash
ls $SEALOS_ROOT/controllers/user/deploy/
# charts/user-controller/  drop/  Kubefile  user-controller-entrypoint.sh
```

开发期可直接用 helm 调试 chart（第 7 章详述全量安装）：

```bash
helm upgrade --install user-controller $SEALOS_ROOT/controllers/user/deploy/charts/user-controller \
  -n user-system --create-namespace \
  --set image.registry=sealos-dev --set image.repository=user-controller --set image.tag=local
```

> chart 的 values 中镜像字段以各 chart 实际定义为准，安装前先 `helm show values` 查看。entrypoint.sh（集群镜像安装脚本）的完整逻辑（读 `sealos-system/sealos-config`、helm upgrade、apply CRD）在第 7 章复刻为可手动执行的步骤。

---

## 本章产出清单

| 产物 | 位置 |
| --- | --- |
| 8 个控制器 linux 二进制 | `$SEALOS_BUILD/controllers/<mod>/` |
| 8 个控制器镜像 | 本地 Docker（`sealos-dev/<mod>-controller:local`） |
| 镜像 tar | `$SEALOS_BUILD/images/<mod>-controller-arm64.tar` |
