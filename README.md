# 今天吃什么？

大家打开同一个网址，就能从周末想吃的餐厅里转一家。页面沿用红金色转盘、站酷快乐体和原有卡片，宽屏左右排列，手机上下排列。字体随站点提供。

## Docker Compose 部署

把项目目录复制到装有 Docker Engine 和 Compose 的服务器，在项目目录运行：

```sh
docker compose up -d --build
docker compose ps
```

浏览器访问 `http://服务器IP:8080`。要让朋友从外网访问，请在服务器防火墙和云安全组放行选定端口，或通过现有的 HTTPS 反向代理发布域名。健康检查地址为 `/healthz`。

首次启动会建立包含 95 条记录的双语餐厅库。原清单 37 条默认参与抽选，另有 58 家可自行加入。这次新增的 35 家中，Arcadia 10 家、San Gabriel 10 家、Pasadena 9 家、Duarte 3 家、Monrovia 2 家、Walnut 1 家。

- 点击右上角 **＋**，可按中英文店名、城市、街道或菜系查找餐厅。点击地址可预览导航，点击「加入」后大家都能抽到。手动添加新店时也可以填写街道地址及电话。
- 已核实的 90 家门店附有街道地址、常规周末营业时间及资料链接。预算为估算，节假日营业时间以门店为准。原清单的「烤鱼」「韩式烤肉」「Curry Pizza」「小李子清粥店」「Love to Eat」仍待确认具体门店；其中四条附有独立的同类备选。
- 预算选项为每人 15、25、40、60、100 美元以内或不限。按估计人均区间的上限计入，例如 20–30 美元的店会出现在 40 美元以内。未知预算只参与不限预算的抽选。金额供选店时参考。
- 从结果卡、最近抽到的店或「查看与评分」进入。每次用餐可提交 1–5 星，名字留空即匿名。同名与匿名评分均独立保存，平均分按全部评分计算，页面展示最近 20 条。

### 使用 GitHub Actions 构建的镜像

推送到 `main` 或手动运行 **Build Docker image** 会构建 Linux amd64 镜像。工作流启动容器验证首页、健康接口和 SQLite 餐厅库，再推送到 `ghcr.io/zerostwo/we-eat`。主分支还会把同一镜像推送到 Docker Hub 私有仓库 `duansq/we-eat`。两个仓库均提供 `sha-<完整提交号>` 和 `latest` 标签。Docker Hub 发布令牌保存在 GitHub Actions 仓库密钥 `DOCKERHUB_TOKEN` 中，轮换时更新该密钥。

服务器只需项目的 `compose.yaml` 和 `.env`。在 `.env` 设置 `WE_EAT_IMAGE=ghcr.io/zerostwo/we-eat:sha-<完整提交号>` 和对外端口。使用 Docker Hub 时，将镜像名设为 `duansq/we-eat:sha-<完整提交号>`。登录相应的私有镜像仓库后运行：

```sh
docker compose pull web
docker compose up -d --no-build --pull never --wait
```

每次成功构建也会在 Actions 运行页保留三天的 `we-eat-linux-amd64` 下载包。解压下载包后运行 `docker load -i we-eat-linux-amd64.tar.gz`，然后执行上面的 Compose 启动命令即可。切换版本时沿用原项目目录及数据卷。

### CloudCone 自动部署

线上地址为 [eat.catplot.org](https://eat.catplot.org/)。主分支构建、容器测试、镜像发布和归档成功后，工作流把当前主分支镜像标记为 `duansq/we-eat:production`。CloudCone 的 `we-eat-update.timer` 每三分钟检查一次，按镜像摘要部署到 `/srv/we-eat`。

服务器使用专用 Docker Hub 只读凭据，路径为 `/srv/we-eat/.docker`。更新脚本复用 `we-eat_meals` 数据卷，切换前将经过完整性校验的 SQLite 快照存到 `/srv/we-eat/backups/`。容器和数据库检查通过后记录新镜像摘要。启动或检查失败会尝试恢复先前镜像，数据库快照可供恢复时使用。

部署脚本和 systemd 单元位于 `deploy/`。服务器可用 `systemctl list-timers we-eat-update.timer` 查看下次检查时间，用 `journalctl -u we-eat-update.service` 查看发布记录。需要立即检查时运行 `systemctl start we-eat-update.service`。

### 修改端口或开启网页管理

首次配置可把 `.env.example` 复制为 `.env`。修改后再运行 `docker compose up -d`。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `8080` | 服务器对外监听的端口 |
| `BIND_ADDRESS` | `0.0.0.0` | 使用同机反向代理时可设为 `127.0.0.1` |
| `ADMIN_TOKEN` | 空 | 设置后页面出现「管理餐厅清单」，可编辑已有餐厅资料，也可添加餐厅 |

可以用 `openssl rand -hex 32` 生成管理密钥，填入服务器的 `.env`。管理时在网页输入密钥，浏览器只在本次保存请求中发送它。公网管理请使用 HTTPS。

## 抽选与共享方式

- 每次由服务端从当前符合条件的餐厅中等概率选一家，指针停到返回的餐厅。已有地址的结果可直接打开 Google Maps，从当前位置前往具体门店。地址待确认时可按店名和区域搜索。
- 所有人共享餐厅和抽选历史。页面打开、重新获得焦点以及停留期间每 20 秒会刷新数据。启用「最近三次不重复」时，服务端按全站最近三次实际抽选过滤，包括其他人刚刚转到的店。
- 菜系、预算、餐次和排除清单保存在各自浏览器。没有候选时，调整筛选或重新勾选店铺即可。
- 修改餐厅不会改写历史里的旧店名。同时编辑同一家店时，后保存的人会收到版本冲突提示。

## 数据与备份

Node.js 24 和 SQLite 运行在一个容器。数据库位于 `/app/data/we-eat.sqlite`，Compose 命名卷 `meals` 保存数据库。固定在同一项目目录部署，普通更新或 `docker compose down` 后再次启动都会复用该卷。`docker compose down -v` 会删除数据。

更新代码后运行 `docker compose up -d --build`。旧版数据卷会自动迁移，保留原店铺 ID、自定义店铺、清单、评分和抽选历史。升级会为未编辑的内置记录补充资料，保留手动编辑的记录。再次启动会沿用迁移后的数据。

在线生成一致的数据库备份并复制到当前目录：

```sh
docker compose exec -T web node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; import {backup} from 'node:sqlite'; const db = new DatabaseSync(process.env.DB_PATH); await backup(db, '/tmp/we-eat-backup.sqlite'); db.close()"
docker compose cp web:/tmp/we-eat-backup.sqlite ./we-eat-backup.sqlite
```

从备份迁移到新服务器时，先将备份放在项目根目录。以下命令针对**新建的空数据卷**，会拒绝覆盖现有数据库：

```sh
docker compose build
docker compose run --rm --no-deps -v "$PWD/we-eat-backup.sqlite:/tmp/restore.sqlite:ro" web node --input-type=module -e "import {copyFileSync,constants} from 'node:fs'; copyFileSync('/tmp/restore.sqlite',process.env.DB_PATH,constants.COPYFILE_EXCL)"
docker compose up -d
```

## 本地运行

安装 Node.js 24 或更高版本后，运行 `npm start` 并访问 `http://localhost:8080`。无需安装 npm 依赖。本地数据库默认存储在 `data/we-eat.sqlite`，可通过环境变量 `DB_PATH`、`HOST`、`PORT` 和 `ADMIN_TOKEN` 配置原生进程。直接双击 HTML 文件无法连接 API。

`今天吃什么.html` 和 `public/` 是页面与静态资源，`restaurants.json` 保存初始清单，`catalog.json` 保存洛杉矶扩充库及资料来源，`server.js` 实现 HTTP 接口和数据库初始化。字体使用 SIL Open Font License，授权文件位于 `public/fonts/`。
