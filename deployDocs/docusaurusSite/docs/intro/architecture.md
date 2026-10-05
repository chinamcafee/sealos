---
sidebar_position: 1
title: 项目架构总览
description: sealos 单仓库架构、各组件源码路径、Mac 原生编译与 Docker 编译的判定结论
---

# 项目架构总览

sealos 是一个 **单仓库（monorepo）** 项目，包含云操作系统的全部源码。仓库根目录：

```
/Users/changzechuan/SaaSProjects/sealos
├── controllers/   # 8 个 Kubernetes 控制器（Go，kubebuilder 风格）
├── service/       # 4 个后端 HTTP 服务（Go）
├── webhooks/      # 2 个准入/注入 webhook（Go）
├── frontend/      # 前端 monorepo（pnpm + Next.js：desktop + 5 个 provider）
├── lifecycle/     # sealos CLI 本体（Go，CGO，负责建集群/装集群镜像）
├── scripts/       # CI 辅助脚本、云安装脚本（install-v2.sh / install-v5.1.sh）
├── deployDocs/    # 本指南所在目录（build/ 放所有构建产物）
└── docs/          # 官方文档
```

## 一、组件清单与源码路径

### 1. Kubernetes 控制器（controllers/）

Go workspace 文件为 `controllers/go.work`（Go 1.25.0），包含 8 个模块：

| 组件 | 源码路径 | 镜像名（IMG 默认值） | 作用 |
| --- | --- | --- | --- |
| user-controller | `controllers/user` | `ghcr.io/labring/sealos-user-controller` | 用户/账户 CRD 与生命周期 |
| account-controller | `controllers/account` | `ghcr.io/labring/sealos-account-controller` | 计费账户、扣费、充值 |
| app-controller | `controllers/app` | `ghcr.io/labring/sealos-app-controller` | App 交付（AppLauncher 等 CRD） |
| license-controller | `controllers/license` | `ghcr.io/labring/sealos-license-controller` | License 管理 |
| node-controller | `controllers/node` | `ghcr.io/labring/sealos-node-controller` | 节点/GPU 管理 |
| resources-controller | `controllers/resources` | `ghcr.io/labring/sealos-resources-controller` | 资源监控与回收 |
| job-init | `controllers/job/init` | `ghcr.io/labring/sealos-job-init-controller` | 集群初始化 Job（preset） |
| job-heartbeat | `controllers/job/heartbeat` | `ghcr.io/labring/sealos-job-heartbeat-controller` | 心跳 CronJob |
| pkg（公共库，无镜像） | `controllers/pkg` | — | 各控制器共享的 Go 库 |

每个控制器模块内都是标准 kubebuilder 结构：

```
controllers/<模块>/
├── main.go（或 cmd/main.go）   # 控制器入口
├── Makefile                    # build / run / docker-build / install / deploy
├── Dockerfile                  # distroless + COPY 预编译二进制
├── config/                     # kustomize（crd/rbac/manager/webhook/certmanager）
└── deploy/                     # 官方发布用：Kubefile + Helm chart（真正用于生产部署）
```

> **重要**：`config/` 下的 kustomize 是 kubebuilder 开发脚手架；官方**真正发布用的是 `deploy/charts/` Helm chart**，被打包成 "集群镜像"（Kubefile）。本指南两种方式都会讲。

### 2. 后端服务（service/）

Go workspace 为 `service/go.work`（Go 1.25.0），service 根模块 + 4 个子模块（通过 replace 直接引用 `../controllers` 源码）：

| 组件 | 源码路径 | 镜像名 | 作用 |
| --- | --- | --- | --- |
| account-service | `service/account` | `ghcr.io/labring/sealos-account-service` | 账户/计费 API |
| database-service | `service/database` | `ghcr.io/labring/sealos-database-service` | 数据库实例管理 API |
| launchpad-service | `service/launchpad` | `ghcr.io/labring/sealos-launchpad-service` | 应用启动器 API |
| vlogs-service | `service/vlogs` | `ghcr.io/labring/sealos-vlogs-service` | 日志服务 |

注意：service 的 Dockerfile 构建上下文是 **仓库根目录**（因为要同时 COPY `service/` 与 `controllers/`）。

### 3. Webhook（webhooks/）

Go workspace 为 `webhooks/go.work`（Go 1.24.6）：

| 组件 | 源码路径 | 镜像名 | 作用 |
| --- | --- | --- | --- |
| admission-webhook | `webhooks/admission` | `ghcr.io/labring/sealos-admission-webhook` | 准入控制（namespace 注入等） |
| stargz-webhook | `webhooks/stargz` | `ghcr.io/labring/sealos/stargz-webhook` | 容器镜像 stargz 懒加载注入 |

### 4. 前端（frontend/）

pnpm monorepo（Node 20.20.2 + pnpm 8.9.0），全部为 Next.js 应用，**用同一个多阶段 Dockerfile**，靠 `--build-arg name/path` 区分：

| 应用 | 源码路径 | 镜像（CI 名） | 作用 |
| --- | --- | --- | --- |
| desktop | `frontend/desktop` | `sealos-desktop-frontend` | 桌面门户主应用（含 Prisma + 双数据库迁移） |
| applaunchpad | `frontend/providers/applaunchpad` | `sealos-applaunchpad-frontend` | 应用启动器前端 |
| dbprovider | `frontend/providers/dbprovider` | `sealos-dbprovider-frontend` | 数据库前端 |
| costcenter | `frontend/providers/costcenter` | `sealos-costcenter-frontend` | 费用中心前端（dev 端口 3001） |
| template | `frontend/providers/template` | `sealos-template-frontend` | 模板市场前端 |
| license | `frontend/providers/license` | `sealos-license-frontend` | License 前端 |

> desktop 是 Web 应用（不是 Electron/Tauri），"桌面" 指云端桌面门户；provider 通过 `packages/client-sdk`（sealos-desktop-sdk）与 desktop 微前端式集成。`frontend/packages/*` 是共享 UI/请求库，必须先构建。

### 5. sealos CLI（lifecycle/）

`lifecycle/` 是 sealos 命令行工具本体（建 K8s 集群、运行"集群镜像"），产出 5 个二进制：`sealos`、`sealctl`、`lvscare`、`image-cri-shim`、`sreg`。**这是全仓库唯一必须用 Linux 容器构建的模块**（原因见下）。

## 二、哪些能在 Mac M 芯片原生编译，哪些必须 Docker（x86 Linux）

这是本指南第一个核心结论（依据：对全仓库 Makefile/Dockerfile 的逐行核实）：

### ✅ 可以在 Mac M 芯片原生编译

**controllers/ 全部、service/ 全部、webhooks/ 全部、frontend/ 全部**：

- Go 侧：所有 Makefile 均为 `CGO_ENABLED=0`（全仓库除 lifecycle 外 grep 不到任何 `CGO_ENABLED=1`），纯 Go 交叉编译无任何 C 库依赖。`make build` 写死 `GOOS=linux`，在 Mac 上交叉产出 Linux 二进制完全可行（传 `GOARCH=arm64` 或 `amd64` 均可）。
- 前端侧：`package.json` 的 `pnpm.supportedArchitectures` 显式声明了 darwin/arm64；仅有的原生依赖 prisma@5.10.2 与 sharp@0.32.6 都有 darwin-arm64 预编译产物；Node 20.20.2 / pnpm 8.9.0 均有 arm64 原生版。

### ❌ 必须在 Linux 容器中编译

**lifecycle/（sealos CLI）**：

- `sealos`、`sealctl`、`sreg` 三个二进制为 `CGO_ENABLED=1` + `-extldflags '-static --static'` 静态链接，依赖 **btrfs、gpgme、devmapper** 的 C 库与 `aarch64-linux-gnu-gcc` / `x86_64-linux-gnu-gcc` 交叉编译器（见 `lifecycle/scripts/make-rules/golang.mk` 与 `lifecycle/.goreleaser.yml`）。Mac 上没有这些 Linux GNU 工具链。
- 官方构建方式就是 `lifecycle/Dockerfile`：`golang:1-bullseye` 容器内安装 `gcc-aarch64-linux-gnu`、`libbtrfs-dev`、`libgpgme-dev`、`libdevmapper-dev` 后执行 `make build`。
- 注意：**不强制 x86_64 容器**。`golang:1-bullseye` 的 arm64 版容器在 M 芯片上原生运行，可直接产出 `linux/arm64` 二进制；只有需要 `linux/amd64` 产物时才用 `--platform linux/amd64`（QEMU 模拟，较慢）。本指南两种都给。

### ⚠️ 与直觉不同、容易误解的两点（按实际调研结论纠正）

1. **前端 Docker 镜像并不"必须" x86**：`frontend/Makefile` 硬编码 `--platform=linux/amd64`（CI 历史原因），在 M 芯片上会走 Rosetta/QEMU 模拟，能成功但很慢。Dockerfile 本身无任何 amd64 专属内容（官方 CI 已在 arm64 原生 runner 上构建成功）。本地构建推荐 `linux/arm64` 原生构建；如需分发给 amd64 集群再加 `--platform linux/amd64`。
2. **Go 控制器的 `make build` 产物本来就是 Linux 二进制**：在 Mac 上执行即可得到 Linux 目标平台的产物，无需进容器。

## 三、构建产物的三类形态

理解 sealos 的产物体系很重要，后文反复出现：

1. **二进制/静态产物**：Go 二进制（`bin/manager`）、前端 `.next` 产物、sealos CLI tar 包。
2. **Docker 运行镜像**：`sealos-<模块>-{controller,service,webhook,frontend}`，多阶段构建或 COPY 预编译二进制，运行于 K8s Pod 中。
3. **集群镜像（cluster image）**：官方发布形态。在 `deploy/Kubefile` 中 `FROM scratch` + COPY registry/charts，用 `sealos build -f Kubefile` 构建，`sealos run` 部署。本地全量部署章节我们既讲官方集群镜像方式，也讲直接用 Helm chart 的通用方式。

## 四、官方 CI 的构建矩阵（供对照）

`.github/workflows/` 中：
- `controllers.yml` / `controller-build.yml`：检测变更模块 → amd64 + arm64 各 `make build` → buildx 多架构推 GHCR → `deploy/` 下 `sealos build` 产出 `sealos-cloud-<模块>-controller` 集群镜像。
- `frontends.yml` / `frontend.yml`、`services.yml` / `service-build.yml`、`webhooks.yml`：同构流程。
- `release.yml`：goreleaser 发布 sealos CLI（仅 Linux 产物）。
- `cloud-release.yml`：统一打一个版本号，全量构建所有云组件。

本指南把 CI 中的每个关键命令都"翻译"成了可在你 Mac 上直接执行的等价命令。
