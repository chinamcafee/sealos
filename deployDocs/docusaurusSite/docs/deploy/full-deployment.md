---
sidebar_position: 60
title: 第 7 章 · 全功能 Sealos 系统部署（本地 K8s 全量拉起）
description: 用第 2-6 章构建的全部镜像，在 kind（或任意 K8s 兼容）环境中部署完整 sealos 云操作系统
---

# 第 7 章 · 全功能 Sealos 系统部署

本章目标：**利用前面各章构建出的所有镜像，在一个本地 Kubernetes 环境（kind）中把 sealos 全量拉起**，并给出迁移到"任意 K8s 兼容环境"的方法。

sealos 官方在真实集群上的安装逻辑（`scripts/cloud/install-v2.sh`，已核实）是：

```
sealos run kubernetes 集群镜像（kubeadm 建集群）
→ 依次 sealos run: helm、cilium(CNI)、cert-manager、openebs(存储)、metrics-server、
   cockroach(+kubeblocks 数据库)、victoria-metrics(监控)、higress(ingress)
→ sealos run sealos-cloud 总装镜像：逐个安装 sealos-cloud-<模块>-{controller,frontend,service,webhook} 集群镜像
   （每个集群镜像的 entrypoint.sh：读 sealos-system/sealos-config ConfigMap → helm upgrade charts → apply CRDs）
→ sealos-certs 配置证书
```

在 Mac 上 `sealos run` 无法建集群，因此本地路径为：**kind 建集群 + 官方依赖镜像/简化依赖 + 直接用 `deploy/charts` Helm chart 安装我们自建的镜像**（与 entrypoint.sh 在集群镜像里做的事完全一致，只是手动执行）。章末再给"真·官方集群镜像"的等价做法。

---

## 第一部分：准备本地 K8s 集群与基础设施

### 7.1 创建 kind 集群（带 ingress 端口映射）

```bash
cat > /tmp/kind-sealos-full.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: sealos-full
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: 80
        hostPort: 80
        protocol: TCP
      - containerPort: 443
        hostPort: 443
        protocol: TCP
EOF
kind create cluster --config /tmp/kind-sealos-full.yaml
kubectl get nodes
```

### 7.2 装载所有自建镜像进 kind（第 2-5 章产物）

```bash
for img in \
  sealos-dev/user-controller sealos-dev/account-controller sealos-dev/app-controller \
  sealos-dev/license-controller sealos-dev/node-controller sealos-dev/resources-controller \
  sealos-dev/job-init-controller sealos-dev/job-heartbeat-controller \
  sealos-dev/account-service sealos-dev/database-service sealos-dev/launchpad-service sealos-dev/vlogs-service \
  sealos-dev/admission-webhook sealos-dev/stargz-webhook \
  sealos-dev/desktop-frontend sealos-dev/applaunchpad-frontend sealos-dev/dbprovider-frontend \
  sealos-dev/costcenter-frontend sealos-dev/template-frontend sealos-dev/license-frontend ; do
  kind load docker-image $img:local --name sealos-full
done
```

> kind 的节点是容器，`kind load` 把本地镜像直接注入节点 containerd，**无需镜像仓库**。多节点/远程集群则改用 `docker push` 到私有仓库（如 `docker run -d -p 5000:5000 registry:2` + 给节点配 insecure-registry），后文 7.12 有说明。

### 7.3 安装基础依赖（与官方 install-v2.sh 对齐）

```bash
# 1) cert-manager（webhook 证书必需）
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl -n cert-manager wait --for=condition=Available deploy --all --timeout=300s

# 2) metrics-server（resources-controller 依赖指标；kind 默认没有）
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system patch deploy metrics-server --type json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

# 3) Ingress（官方用 higress；本地简化用 ingress-nginx，功能等价：暴露桌面域名路由）
kubectl apply -f https://kind.sigs.k8s.io/examples/ingress/manifest.yaml   # kind 官方 ingress-nginx 清单
kubectl wait --namespace ingress-nginx --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=300s
```

### 7.4 安装数据库（MongoDB + CockroachDB）

官方用 KubeBlocks 管理 CockroachDB，MongoDB 由 KubeBlocks/托管实例提供。本地简化为单实例 Helm 安装：

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

# MongoDB（desktop 与 account/license 用；官方连接串键名 databaseMongodbURI）
helm upgrade --install mongo bitnami/mongodb -n sealos-system --create-namespace \
  --set auth.username=sealos --set auth.password=sealospw --set auth.database=admin
MONGO_URI="mongodb://sealos:sealospw@mongo-mongodb.sealos-system.svc.cluster.local:27017/sealos-auth?authSource=admin"

# CockroachDB（desktop Prisma global/region 用，provider=cockroachdb）
helm repo add cockroachdb https://charts.cockroachdb.com/
helm upgrade --install cockroach cockroachdb/cockroachdb -n sealos-system \
  --set statefulset.replicas=1 --set conf.single-node=true \
  --set storage.persistentVolume.size=5Gi
kubectl -n sealos-system rollout status sts/cockroach-cockroachdb --timeout=600s
```

### 7.5 写入 sealos 全局配置 ConfigMap（entrypoint.sh 的数据源）

所有组件的 entrypoint.sh 都从 `sealos-system/sealos-config` 读取全局配置（官方默认 `cloudDomain=127.0.0.1.nip.io`）：

```bash
kubectl -n sealos-system create configmap sealos-config --from-literal=cloudDomain=127.0.0.1.nip.io \
  --from-literal=apiserverPort=6443 \
  --from-literal=databaseMongodbURI="$MONGO_URI" \
  --from-literal=passwordSalt=dev-salt --from-literal=jwtSecret=dev-jwt \
  --dry-run=client -o yaml | kubectl apply -f -
```

> nip.io 域名（`127.0.0.1.nip.io` 解析到 127.0.0.1）是官方默认的免 DNS 本地方案。你自建集群时换成自己的域名。

---

## 第二部分：安装全部 sealos 组件（Helm chart 方式）

各组件 chart 位于 `<组件>/deploy/charts/`。安装动作与各 entrypoint.sh 完全一致：`helm upgrade -i <release> -n <ns> --create-namespace ./charts/<name>`。

### 7.6 替换 chart 中镜像为本地镜像

chart values 默认指向 `ghcr.io/labring/...:latest`。安装前先看实际字段名，再替换（与 CI 的 sed 做法一致）：

```bash
helm show values $SEALOS_ROOT/controllers/user/deploy/charts/user-controller | grep -A5 -i image
```

通用替换脚本（把官方镜像名替换为本地自建镜像；**若 grep 发现 values 中镜像字段结构不同，请按 7.6 输出手工调整 sed 表达式**）：

```bash
# 以 user-controller 为例：
cd $SEALOS_ROOT/controllers/user/deploy
cp -r charts /tmp/user-chart
grep -rl "ghcr.io/labring" /tmp/user-chart | xargs sed -i '' \
  's#ghcr.io/labring/sealos-user-controller:[a-zA-Z0-9._-]*#sealos-dev/user-controller:local#g'
grep -rn "image" /tmp/user-chart/*/values.yaml | head   # 确认替换成功
```

### 7.7 安装 8 个控制器

对照 entrypoint.sh 的顺序与命名空间（namespace 以各 chart values/entrypoint 为准，常见为 `<模块>-system`）：

```bash
install_chart() {  # 用法: install_chart <repo路径/deploy> <release名> <namespace>
  cd $1
  helm upgrade --install $2 ./charts/* -n $3 --create-namespace
}
install_chart $SEALOS_ROOT/controllers/user/deploy        user-controller        user-system
install_chart $SEALOS_ROOT/controllers/account/deploy     account-controller     account-system
install_chart $SEALOS_ROOT/controllers/app/deploy         app-controller         app-system
install_chart $SEALOS_ROOT/controllers/license/deploy     license-controller     license-system
install_chart $SEALOS_ROOT/controllers/node/deploy        node-controller        node-system
install_chart $SEALOS_ROOT/controllers/resources/deploy   resources-controller   resources-system
```

job-init / job-heartbeat 是集群初始化 Job（不在本地 kind 常驻运行，官方在集群安装期执行）；如需执行：

```bash
# job/init 的 deploy 里是 preset Job，直接 apply manifests（如有）或用镜像手动跑一次性 Job：
kubectl -n kube-system create job --image=sealos-dev/job-init-controller:local preset-init -- /manager
```

（`resources-controller` 无 CRD，`user/account/app/license/node` 安装后用 `kubectl get crd | grep sealos` 验证 CRD 已注册。）

### 7.8 安装 admission webhook

```bash
cd $SEALOS_ROOT/webhooks/admission/deploy
cp -r charts /tmp/admission-chart 2>/dev/null || cp -r manifests /tmp/admission-manifests
grep -rl "ghcr.io/labring" /tmp/admission-* | xargs sed -i '' \
  's#ghcr.io/labring/sealos-admission-webhook:[a-zA-Z0-9._-]*#sealos-dev/admission-webhook:local#g'
# charts 存在则 helm 安装；否则直接 apply manifests：
helm upgrade --install admission-webhook /tmp/admission-chart/* -n admission-webhook-system --create-namespace \
  || kubectl apply -f /tmp/admission-manifests
```

### 7.9 安装 4 个后端服务

```bash
svc_chart() {
  cd $SEALOS_ROOT/service/$1/deploy
  if [ -d charts ]; then
    cp -r charts /tmp/$1-chart
    grep -rl "ghcr.io/labring" /tmp/$1-chart | xargs sed -i '' \
      "s#ghcr.io/labring/sealos-$1-service:[a-zA-Z0-9._-]*#sealos-dev/$1-service:local#g"
    helm upgrade --install $1-service /tmp/$1-chart/* -n sealos-system
  else
    cp -r manifests /tmp/$1-manifests
    grep -rl "ghcr.io/labring" /tmp/$1-manifests | xargs sed -i '' \
      "s#ghcr.io/labring/sealos-$1-service:[a-zA-Z0-9._-]*#sealos-dev/$1-service:local#g"
    kubectl apply -f /tmp/$1-manifests
  fi
}
svc_chart account
svc_chart database
svc_chart launchpad
svc_chart vlogs
```

### 7.10 安装 6 个前端

```bash
fe_chart() {
  cd $SEALOS_ROOT/frontend/$1/deploy
  cp -r charts /tmp/fe-$1-chart
  grep -rl "ghcr.io/labring" /tmp/fe-$1-chart | xargs sed -i '' \
    "s#ghcr.io/labring/sealos-$1-frontend:[a-zA-Z0-9._-]*#sealos-dev/$1-frontend:local#g"
  # databaseMongodbURI 等 env 来自 sealos-config；desktop 还需要 Prisma 迁移，参考 desktop-frontend-entrypoint.sh：
  helm upgrade --install $1-frontend /tmp/fe-$1-chart/* -n sealos-system
}
fe_chart desktop
fe_chart applaunchpad
fe_chart dbprovider
fe_chart costcenter
fe_chart template
fe_chart license
```

> desktop 首次启动会执行 `prisma migrate deploy`（镜像内已内置迁移文件与全局 prisma）。若 Pod 卡在 Init/CrashLoop，`kubectl -n sealos-system logs <desktop-pod>` 看是否数据库连接问题，回查 7.4/7.5。

### 7.11 验证

```bash
kubectl get pods -A | grep -E "user|account|app-|license|node|resources|frontend|admission|service"
# 期望所有相关 Pod Running。逐个抽查日志无 FATAL：
kubectl -n user-system logs deploy/$(kubectl -n user-system get deploy -o name | head -1 | cut -d/ -f2) | tail -20
```

访问桌面（通过 port-forward 最简单）：

```bash
kubectl -n sealos-system get svc | grep desktop
kubectl -n sealos-system port-forward svc/<desktop-svc名> 3000:3000
# 浏览器打开 http://localhost:3000
```

或走 ingress（7.3 的 ingress-nginx + `127.0.0.1.nip.io` 域名路由），需按 desktop chart 的 HELLM_VALUES_GUIDE（`frontend/desktop/deploy/HELM_VALUES_GUIDE.md`）配置 host 规则。

---

## 第三部分：官方"集群镜像"等价做法（进阶，可选）

若你希望在 **Linux 服务器集群** 上完整复刻官方安装（`sealos run`），把第 2-6 章的 Docker 镜像打成集群镜像：

### 7.12 构建集群镜像

以 user-controller 为例（CI 的 `cluster-image-build` job 等价物；需要 sealos CLI，Mac 上用 darwin 版）：

```bash
cd $SEALOS_ROOT/controllers/user/deploy
mkdir -p registry/sealos-dev
# 把自建 docker 镜像导出为 registry 目录布局（sealos build 会把它灌进集群内置 registry sealos.hub:5000）
docker save sealos-dev/user-controller:local -o registry-sealos-dev-user-controller.tar

cat > Kubefile.local <<'EOF'
FROM scratch
USER 65534:65534
COPY registry registry
COPY charts charts
COPY drop drop
COPY user-controller-entrypoint.sh user-controller-entrypoint.sh
CMD ["bash user-controller-entrypoint.sh"]
EOF
sealos build -f Kubefile.local -t sealos-cloud-dev/user-controller:local .
docker save sealos-cloud-dev/user-controller:local -o $SEALOS_BUILD/cluster-images/user-controller-cluster.tar
```

> 官方 CI 中 `registry/` 目录布局由脚本从镜像生成（把 `ghcr.io/labring/xxx` 放到 `registry/labring/xxx` 路径）。手工等价做法：`mkdir -p registry/sealos-dev && docker save` 后用 `skopeo copy docker-daemon:sealos-dev/user-controller:local dir:$PWD/registry/sealos-dev/user-controller:local`（`brew install skopeo`）。

### 7.13 在 Linux 集群上 sealos run

```bash
# 在 Linux 服务器上（非 Mac）：
sealos run labring/kubernetes:v1.28.x --masters x.x.x.x    # 或连已有集群
sealos run labring/cert-manager:v1.8.0 labring/helm:v3.9.4 ...
for img in $(ls $SEALOS_BUILD/cluster-images/*.tar 中的镜像); do
  sealos load -i <tar>
done
sealos run sealos-cloud-dev/user-controller:local \
  --env SEALOS_CLOUD_DOMAIN=cloud.example.com
```

完整依赖清单与顺序照抄 `scripts/cloud/install-v2.sh` 中的 `cloudImages` 映射表（kubernetes、cilium、cert-manager、helm、openebs、higress、kubeblocks、cockroach、metrics-server、victoria-metrics-k8s-stack、sealos-cloud、sealos-certs、sealos-finish）。

### 7.14 迁移到任意 K8s 兼容环境

1. 目标集群必须能拉到你的镜像：`docker push` 到目标环境可达的 registry（并把 7.6 的 sed 目标改成该 registry 前缀）；
2. 安装 7.3/7.4 等价依赖（cert-manager、metrics-server、ingress、MongoDB、CockroachDB）；
3. 重复 7.5-7.11 的 chart 安装步骤；
4. `kubectl get pods -A` 全绿即完成。

---

## 全书产出总览（审计清单）

跑完全部章节后，`$SEALOS_BUILD` 应包含：

```
deployDocs/build/
├── controllers/<8 个模块>/manager-linux-arm64       # 第 3 章
├── services/<4 个模块>/manager-linux-arm64          # 第 4 章
├── webhooks/{admission,stargz}/...                  # 第 5 章
├── lifecycle/release/{linux_arm64,linux_amd64}/     # 第 6 章（Docker 构建）
├── frontend/<6 个应用>/standalone/                  # 第 2 章
├── images/*.tar                                     # 全部镜像 tar
├── cluster-images/                                  # 第 7 章集群镜像（可选）
└── site/                                            # 本指南站点
本地 Docker：sealos-dev/* 21 个镜像；kind 集群 sealos-full：全组件 Running。
```

## 常见问题排查

| 现象 | 原因与处理 |
| --- | --- |
| 控制器 Pod `CreateContainerConfigError` | 镜像没 load 进 kind（7.2 重跑）或架构不符（amd64 镜像跑在 arm64 kind） |
| desktop 崩溃循环 | Prisma 连不上数据库：检查 7.4 连接串与 7.5 的 `databaseMongodbURI` |
| webhook Pod NotReady | cert-manager 未就绪或 CA 注入失败：`kubectl -n cert-manager get certs` |
| kind 集群 443 访问不通 | 7.1 的 extraPortMappings 被占用：换 hostPort 或用 port-forward |
| 前端页面空白 | `SEALOS_CLOUD_DOMAIN`/Ingress 路由未配：看 desktop chart 的 HELM_VALUES_GUIDE |
