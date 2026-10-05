---
title: 首页
---

# Sealos 本地构建与部署指南

本站是一套面向 **0 基础读者** 的、事无巨细的指南：如何在 **Mac（Apple Silicon / M 芯片）** 上从 [labring/sealos](https://github.com/labring/sealos) 源码编译 **全部组件**（前端、后端服务、Kubernetes 控制器、webhook、sealos CLI），并把这些产物打包成镜像，最终在一个本地 Kubernetes 环境中把整套 Sealos 云操作系统 **全量拉起**。

## 指南结构

每个组件章节都严格分为三部分：

1. **Dev 开发模式** —— 如何在本地跑起来进行开发调试；
2. **Release 产物构建** —— 如何构建正式发布产物（二进制 / 前端静态产物）；
3. **打包 K8s 镜像** —— 如何把产物打包成可在 Kubernetes 中运行的容器镜像。

## 快速开始

- 先阅读 [项目架构总览](/docs/intro/architecture) 与 [环境准备](/docs/intro/prerequisites)
- 再按章节顺序构建各组件
- 最后进入 [全功能 Sealos 系统部署](/docs/deploy/full-deployment)

## 核心结论（先看这个）

| 组件组 | 源码路径 | Mac M 芯片能否原生编译 | 镜像产物 |
| --- | --- | --- | --- |
| 前端（desktop + 5 个 provider） | `frontend/` | ✅ 可以（Node/pnpm 均有 arm64 原生支持） | `sealos-<模块>-frontend` |
| 控制器 ×8 | `controllers/` | ✅ 可以（纯 Go，CGO_ENABLED=0，交叉编译无障碍） | `sealos-<模块>-controller` |
| 后端服务 ×4 | `service/` | ✅ 可以（纯 Go，CGO_ENABLED=0） | `sealos-<模块>-service` |
| Webhook ×2 | `webhooks/` | ✅ 可以（纯 Go） | `sealos-<模块>-webhook` |
| sealos CLI（lifecycle） | `lifecycle/` | ❌ 必须 Linux 容器（CGO_ENABLED=1 + 静态链接 btrfs/gpgme/devmapper C 库） | CLI 二进制 + 集群镜像构建工具 |
