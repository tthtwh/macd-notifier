# ETF / 指数 MACD 回测与 512760 通知

一个合并后的单容器项目：

- 浏览器页面用于沪深 ETF 和 `88xxxx` 同花顺指数的 MACD 日线回测，例如半导体指数 `881121`。
- 后台任务仅监控 `512760`，使用固定 MACD `(12,26,9)`，工作日 `14:55` 检查并通过 Server酱通知。

回测页面的 MACD 参数可以调整，但不会改变后台通知参数。

## 通知规则

- 昨日 Hist `<= 0` 且今日 `> 0`：BUY，发送“512760 MACD翻红，可以买入”。
- 昨日 Hist `>= 0` 且今日 `< 0`：SELL，发送“512760 MACD翻绿，可以卖出”。
- 其他情况发送每日 MACD 状态，不产生交易信号。

每日状态包含最新价格、昨日/今日 Hist、柱体变长或缩短，以及按 14:55 行情反推的翻红/翻绿临界价格和所需涨跌幅。临界价格表示“当天价格取该值时 Hist 刚好等于 0”，是实时估算，不是未来走势预测。

最新日 K 不是当天、数据不足或行情获取失败时，会发送“今日检查失败”。任一报告成功发送后都会把日期和结果写入 `data/state.json`，防止同一天重复通知。

## 本地运行

要求 Node.js 22.12 或更高版本。

```bash
npm install
copy data\.env.example data\.env
npm run build
npm start
```

在 `data/.env` 中配置：

```dotenv
SERVERCHAN_SENDKEY=你的SendKey
```

访问 `http://localhost:8080`。`npm start` 会同时启动回测页面和通知调度器。

只开发回测页面时可运行 `npm run dev`；此命令不会启动通知任务。

## 测试

```bash
npm test
npm run test-notify
```

`test-notify` 会真实发送 Server酱测试消息。

## Docker / 极空间

直接构建并启动：

```bash
docker compose up -d --build
```

回测页面默认映射到 NAS 的 `8080` 端口。

极空间 ARM64 镜像：

```bash
docker buildx build --platform linux/arm64 -t macd-lab:arm64 --load .
docker save -o macd-lab-arm64.tar macd-lab:arm64
```

导入镜像后，在极空间 Compose 中使用 `compose.zspace.yaml`。它会把：

- `8080` 映射为回测页面端口；
- `/SATA存储11/macd` 挂载到容器 `/app/data`；
- `/SATA存储11/macd/.env` 保存 `SERVERCHAN_SENDKEY`；
- `/SATA存储11/macd/state.json` 保存通知去重状态；
- `/SATA存储11/macd/query-history.json` 保存页面最近查询记录。

在极空间的 `/SATA存储11/macd/.env` 写入：

```dotenv
SERVERCHAN_SENDKEY=你的SendKey
```

容器每次启动都会读取这个文件。换镜像或重建容器时，只要继续挂载同一个文件夹，SendKey、通知状态和搜索记录都不会丢失。

查看日志：

```bash
docker compose logs -f --tail=100
```

正常启动日志会同时出现：

```text
512760 MACD 通知服务已启动（Asia/Shanghai，工作日 14:55）
回测页面已启动：http://0.0.0.0:8080
```

> 回测结果和 MACD 通知仅供策略研究，不构成投资建议。
