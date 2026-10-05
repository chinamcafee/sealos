---
sidebar_position: 2
title: 环境准备（0 基础）
description: 手把手安装 Mac M 芯片上所需的所有工具：Homebrew、Docker Desktop、Go、Node/pnpm、kubectl/kind/helm/kustomize/controller-gen、sealos CLI
---

# 环境准备（假定你从零开始）

本指南全程使用两个环境变量，**请先在终端确认**：

```bash
# 仓库根目录
SEALOS_ROOT=/Users/changzechuan/SaaSProjects/sealos
# 所有构建产物统一输出目录（本指南所有命令都往这里放产物）
export SEALOS_BUILD=$SEALOS_ROOT/deployDocs/build
```

建议把 `export SEALOS_BUILD=...` 写进 `~/.zshrc`：

```bash
echo 'export SEALOS_ROOT=/Users/changzechuan/SaaSProjects/sealos' >> ~/.zshrc
echo 'export SEALOS_BUILD=$SEALOS_ROOT/deployDocs/build' >> ~/.zshrc
source ~/.zshrc
```

> 后文所有命令默认 `SEALOS_ROOT` 和 `SEALOS_BUILD` 已生效。也可以自行改仓库路径，但 `$SEALOS_BUILD` 的约定贯穿全文，请保持。

## 1. 命令行工具与 Homebrew

macOS 上按 `Command + 空格` 搜索 "终端"（Terminal）打开。逐条执行：

```bash
# 安装 Xcode 命令行工具（git、make 等，若已装会直接跳过）
xcode-select --install

# 安装 Homebrew（macOS 包管理器，已装则跳过）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 按提示把 brew 加入 PATH（Apple Silicon 的默认路径）：
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zshrc
source ~/.zshrc

# 验证
git --version
make --version
brew --version
```

## 2. Docker Desktop（必装，含 Rosetta 加速）

前端镜像、sealos CLI、集群镜像构建都依赖 Docker。

1. 下载安装：https://www.docker.com/products/docker-desktop/ （选 Apple Silicon 版）。
2. 启动 Docker Desktop，等菜单栏鲸鱼图标稳定。
3. **建议开启 Rosetta 加速**（让 x86 容器跑得快）：Docker Desktop → Settings → General → 勾选 `Use Rosetta for x86_64/amd64 emulation on Apple Silicon`（需 macOS 13+）。不开也能跑，只是 x86 容器慢。
4. 验证并确认 buildx 可用：

```bash
docker version
docker buildx version
```

## 3. Go（controllers/service/webhooks 用）

仓库要求：controllers 与 service 的 go.work 声明 `go 1.25.0`，webhooks 为 `go 1.24.6`，CI 用 1.24。安装 1.25 即可全部覆盖：

```bash
brew install go
go version   # 应输出 go1.25.x
```

（Go 工具链会自动按 go.work 声明下载所需小版本，无需手动多装。）

国内网络可选加速：

```bash
go env -w GOPROXY=https://goproxy.cn,direct
```

## 4. Node.js 20.20.2 + pnpm 8.9.0（前端用）

前端锁定 `node 20.20.2`（`frontend/.nvmrc`）与 `pnpm 8.9.0`（`engines`）：

```bash
# 安装 nvm（Node 版本管理器）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.zshrc

# 安装并使用项目锁定版本
cd $SEALOS_ROOT/frontend
nvm install 20.20.2
nvm use 20.20.2
node -v   # v20.20.2

# 启用 corepack 并激活 pnpm 8.9.0（corepack 是 Node 自带，无需另装）
corepack enable
corepack prepare pnpm@8.9.0 --activate
pnpm -v   # 8.9.0
```

国内网络可选：

```bash
pnpm config set registry https://registry.npmmirror.com
```

## 5. 本地 Kubernetes 与部署工具

```bash
# kubectl（操作 k8s 集群的命令行）
brew install kubectl

# kind（用 Docker 容器模拟 k8s 节点，本地拉起集群最简单的方式）
brew install kind

# helm（部署 controllers/*/deploy/charts 下的 Helm chart 必须）
brew install helm

# kustomize（控制器 config/ 目录、make install 用）
brew install kustomize

# 验证
kubectl version --client
kind version
helm version
kustomize version
```

controller-gen / kustomize 等控制器开发工具不必预装 —— 各模块 Makefile 会自动下载到 `$(go env GOPATH)/bin`（确保 `$(go env GOPATH)/bin` 在 PATH 中）：

```bash
echo 'export PATH=$PATH:$(go env GOPATH)/bin' >> ~/.zshrc
source ~/.zshrc
```

## 6. sealos CLI（部署阶段用）

两种方式任选：

```bash
# 方式 A：用官方安装脚本装 release 版（推荐，部署阶段需要）
curl -sfL https://raw.githubusercontent.com/labring/sealos/main/scripts/install.sh | sh -s v5.0.1 labring/sealos
sealos version

# 方式 B：用本指南第 6 章自己从源码构建的 lifecycle 产物（构建完成后再替换）
```

> 注意：在 Mac 上 `sealos run` 无法直接创建 k8s 集群（它面向 Linux 主机），但 `sealos build`（构建集群镜像）在 Mac 上可用。本地集群我们用 kind 创建，sealos CLI 用于集群镜像构建与（可选的）`sealos run` 安装组件。

## 7. 创建统一构建产物目录

执行一次（后文所有产物都落到这里，**所有 Docker 构建的工作目录/产物目录也都挂载这里**）：

```bash
mkdir -p $SEALOS_BUILD/{frontend/{desktop,applaunchpad,dbprovider,costcenter,template,license},\
controllers/{user,account,app,license,node,resources,job-init,job-heartbeat},\
services/{account,database,launchpad,vlogs},\
webhooks/{admission,stargz},\
lifecycle,images,cluster-images,site}
tree -L 2 $SEALOS_BUILD 2>/dev/null || find $SEALOS_BUILD -type d
```

预期目录结构（含义见下一章 [构建目录约定](/docs/intro/build-layout)）：

```
deployDocs/build/
├── frontend/{desktop,applaunchpad,dbprovider,costcenter,template,license}
├── controllers/{user,account,app,license,node,resources,job-init,job-heartbeat}
├── services/{account,database,launchpad,vlogs}
├── webhooks/{admission,stargz}
├── lifecycle/      # sealos CLI 二进制产物
├── images/         # 所有 docker save 导出的镜像 tar
├── cluster-images/ # 集群镜像（sealos build 产物）
└── site/           # 本 Docusaurus 站点构建产物
```

## 8. 环境自检清单

逐条执行，全部成功即环境就绪：

```bash
git --version && make --version && brew --version
docker version && docker buildx version
go version          # >= 1.25
node -v             # v20.20.2
pnpm -v             # 8.9.0
kubectl version --client && kind version && helm version && kustomize version
echo $SEALOS_ROOT && echo $SEALOS_BUILD
```

## 9.（可选）构建并预览本指南站点

本指南本身就是一个 Docusaurus（React）站点：

```bash
cd $SEALOS_ROOT/deployDocs/docusaurusSite
npm install
npm run build          # 产物输出到 build/ （站点自身的 build，会被复制到 $SEALOS_BUILD/site）
cp -r build $SEALOS_BUILD/site
npm run serve          # 浏览器打开 http://localhost:5410 阅读本指南
```
