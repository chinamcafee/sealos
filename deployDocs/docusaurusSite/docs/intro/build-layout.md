---
sidebar_position: 3
title: 构建目录约定
description: 所有构建产物统一落在 deployDocs/build；Docker 构建的工作目录、中间产物、最终产物全部挂载该目录
---

# 构建产物目录约定（贯穿全指南）

本指南强制约定：**一切构建产物（包括 Docker 构建的工作目录、中间产物、最终产物）都放在 `$SEALOS_BUILD`（即 `/Users/changzechuan/SaaSProjects/sealos/deployDocs/build`）的对应子目录中**，绝不散落在系统其他位置。这样你可以随时 `du -sh` 查看体积、整体备份、或整目录删除重来。

## 目录语义

| 子目录 | 存放内容 | 由哪章产生 |
| --- | --- | --- |
| `frontend/<app>` | 各前端应用的构建中间产物与日志 | 第 2 章 |
| `controllers/<mod>` | 各控制器 Linux 二进制（`bin/`） | 第 3 章 |
| `services/<mod>` | 各服务 Linux 二进制 | 第 4 章 |
| `webhooks/<mod>` | webhook Linux 二进制 | 第 5 章 |
| `lifecycle/` | sealos CLI 及全部子命令的 Linux 二进制（Docker 内构建后拷出） | 第 6 章 |
| `images/` | `docker save` 导出的所有 Docker 镜像 tar 包 | 各章"打包镜像"小节 |
| `cluster-images/` | `sealos build` 产出的集群镜像 | 第 7 章 |
| `site/` | 本 Docusaurus 站点静态产物 | 环境准备章 |

## Docker 挂载规则（重要）

凡是"必须在 Docker 里构建"的步骤，命令一律形如：

```bash
docker run --rm \
  -v $SEALOS_ROOT:/src \          # 源码只读挂进容器（工作目录）
  -v $SEALOS_BUILD/lifecycle:/out \ # 产物目录挂出容器（最终产物）
  -w /src/lifecycle \
  golang:1-bullseye \
  bash -c "<容器内执行的构建命令，产物写入 /out>"
```

- **工作目录**：`-v $SEALOS_ROOT:/src` + `-w /src/<模块>`，容器内看到的就是你的源码树；
- **中间产物**：通过 `-e` 环境变量把 Makefile 的输出目录指到 `/out`（或构建后 `cp` 到 `/out`），从而落到宿主机 `$SEALOS_BUILD` 下；
- **最终产物**：`/out` 中的二进制、以及后续 `docker save -o $SEALOS_BUILD/images/xxx.tar` 的镜像 tar。

每个涉及 Docker 的命令在本指南中都会完整给出，直接复制执行即可。

## 命名与 tag 约定

为与官方 CI 对齐又避免污染公共仓库，本指南统一使用：

- 本地镜像名：`sealos-dev/<模块>-<类型>:local`（例如 `sealos-dev/user-controller:local`）
- 镜像 tar：`$SEALOS_BUILD/images/<模块>.tar`
- 集群镜像：`sealos-cloud-dev/<模块>:local`

## 一键清理

```bash
# 只清产物，不动源码
rm -rf $SEALOS_BUILD
# 同时清掉各模块源码目录里 make 产生的 bin/
find $SEALOS_ROOT/controllers $SEALOS_ROOT/service $SEALOS_ROOT/webhooks -maxdepth 3 -type d -name bin -exec rm -rf {} +
```
