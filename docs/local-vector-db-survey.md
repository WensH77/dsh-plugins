# 本机语义检索：本地向量数据库选型调研

调研日期 2026-10-19。版本号与许可证是 2026-10-19 核实的，实测数字是本机跑出来的；方法写在对应位置，没验证的地方会写明。

## 结论先行

- **10 万 chunk 以内、384 维：sqlite-vec 就够。** 零原生编译，结果精确，单文件，10 万条查询 20.7 ms。
- **要更快或到 50 万条：LanceDB。** 同一条数据上它的暴力扫描也比 sqlite-vec 快 3.6 倍（50 万 × 384：37.9 ms 对 135.7 ms）；加索引后能到 1–2 ms。
- **索引选型比选库更容易出错。** 同一份聚类数据上，IVF_FLAT 召回 1.000、HNSW_SQ 召回 0.946，而 IVF_PQ 只有 0.061。任何没写清"是否量化、nprobes/ef 取值、召回口径"的基准都不能横比。
- **数据有没有簇结构，决定 ANN 有没有用。** 同一套 usearch HNSW，随机数据 ef=256 召回 0.471，聚类数据 ef=32 召回 0.989。真实 embedding 接近后者。
- **需要独立服务时只考虑 Qdrant**：单二进制、无 JVM、有官方 Node 客户端。Milvus Lite 只有 Python，Chroma 在 Node 上必须常驻服务。
- 前提：用 `node:sqlite` 加载扩展需要 Node 22.13 以上。

## 一、先把约束定下来

选型结论几乎完全由下面几条决定，脱离它们比较"哪个向量库最好"没有意义。

**1. 宿主是 Node 进程内的 dsh 插件，不是独立服务。**
这个仓库里的插件都是 ESM 包，由 dsh 主进程加载（`package.json` 里 `type: module` + `dsh` 字段，见 [command-setting/package.json](../command-setting/package.json)）。所以要嵌进来的东西，最好是同一进程里的一个模块或一个 SQLite 扩展；起 Docker、起独立守护进程都会多一层部署和故障面。

**2. 本机条件**
- Apple M5 Pro，24 GB 内存，macOS 27.0.1，Node v26.0.0，pnpm 11.22.0，可用磁盘 769 GB。
- `node:sqlite` 的 `loadExtension()` / `allowExtension` 从 **v22.13.0** 起提供（[Node 官方文档](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)），意味着 Node 22.13 以上可以**零原生编译**加载 sqlite-vec。
- 本机没有 Docker，没有 Postgres，Java 只有 8。

**3. 数据规模**
5 万–50 万个 chunk，384 或 768 维 float32。按这个算原始向量体积：

| chunk 数 | 384 维 | 768 维 |
|---|---|---|
| 10 万 | 153.6 MB | 307.2 MB |
| 50 万 | 768 MB | 1536 MB |

纯向量体积不大，真正的取舍在**查询延迟**，不在存储。

**4. 交互式检索，查询要快**
检索挂在对话流程里时，单次超过 100 ms 用户能感觉到卡顿；而且同步 API 会阻塞 dsh 主进程的事件循环。

## 二、本机实测：sqlite-vec

**能跑通，且不需要编译任何原生模块：**

```js
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';

const db = new DatabaseSync('vec.db', { allowExtension: true });
sqliteVec.load(db);                       // 加载 sqlite-vec 0.1.9 的预编译动态库
db.exec(`create virtual table v using vec0(
  embedding float[384],            -- 默认 L2；distance_metric=cosine 则用余弦
  tag text partition key           -- 分区键，用于过滤
)`);
```

`sqlite-vec@0.1.9`（MIT OR Apache-2.0）按平台带 optionalDependencies 的预编译二进制，macOS arm64 命中 `sqlite-vec-darwin-arm64`（168 KB），安装没有触发 node-gyp 编译。

**实测结果**（随机向量，k=10，单线程同步调用，100 次查询取分位）：

| 规模 | 维度 | 插入耗时 | 库文件 | KNN p50 / p95（cosine） | partition key 过滤 p50 / p95 |
|---|---|---|---|---|---|
| 10 万 | 384 | 5.0 s | 152.4 MB | 36.8 / 38.6 ms | 9.2 / 9.7 ms |
| 10 万 | 768 | 16.9 s | 302.6 MB | 88.5 / 126.9 ms | 21.6 / 34.3 ms |
| 50 万 | 384 | 26.8 s | 750.1 MB | 189.1 / 201.9 ms | 47.0 / 49.3 ms |

**第一件能省一半时间的事：用 L2 而不是 cosine。**
向量预先归一化后，L2 距离的排序与余弦距离完全等价。同样 10 万条 384 维，`distance_metric=cosine` 是 37.2 ms，默认 L2 是 21.7 ms，差 1.7 倍。原因是 cosine 每次比较要额外算两个范数。

**第二件：插入慢是驱动的问题，不是 sqlite-vec 的。**
同一份数据、同一个表结构，10 万条插入：`node:sqlite` 用 5.0 s，`better-sqlite3` 只要 1.2 s（快 4 倍）。查询侧两者基本持平（L2 21.7 ms 对 20.7 ms）。一次性灌库、之后只读，用哪个都行；增量写入频繁，`better-sqlite3` 值得为此引入原生依赖。

**实测中撞到的硬限制**（比延迟更影响架构）：

1. **KNN 查询不能对 auxiliary column 加过滤条件**。写成 `where embedding match ? and tag='a' and k=10`（`+tag text` 辅助列）会直接报错：
   `An illegal WHERE constraint was provided on a vec0 auxiliary column in a KNN query.`
   带过滤的 KNN 只能用 `partition key`，否则只能"先取更大的 k 再在外面过滤"，召回率会打折。
2. **没有 ANN 索引**，延迟随 N 线性增长。维护者在 [issue #25](https://github.com/asg017/sqlite-vec/issues/25) 写明 v0.1.0 起就是 brute-force only，到 2026-06 仍 open。仓库里虽然有 `sqlite-vec-ivf.c`、`sqlite-vec-diskann.c` 的 alpha 代码，但文档没写、也没有基准结果，不能当可用功能。
3. **API 是同步的**。`DatabaseSync` 的查询会阻塞事件循环 20–190 ms。挂在 dsh 主进程里，要么放进 `worker_threads`，要么接受这个卡顿。
4. 建表和查询只支持 `k` 或 `LIMIT` 二选一，同时写会报 `Only LIMIT or 'k =?' can be provided, not both`。
5. partition key 有写放大：同样 10 万条，带 partition key 插入 5.0 s，不带（auxiliary column）只要 0.96 s。

## 三、候选方案对比

### 3.1 嵌入式 / 进程内

版本号取自 npm registry API，许可证取自各包元数据，核实日 2026-10-19。

| 方案 | 最新版本 | 许可证 | 与 Node 的集成 | 索引 | 过滤 / 混合检索 | 持久化 | 关键限制 |
|---|---|---|---|---|---|---|---|
| **sqlite-vec** | 0.1.9（2026-03-31） | MIT OR Apache-2.0 | `node:sqlite`（≥22.13）或 better-sqlite3 加载扩展；预编译二进制 168 KB | **暴力扫描，无 ANN** | SQL WHERE，但只有 partition key 能进 KNN；无内置 BM25 | SQLite 单文件 | 延迟随 N 线性 |
| **LanceDB** | 0.40.0（2026-10-07） | Apache-2.0 | `@lancedb/lancedb`，napi 预编译，darwin-arm64 包 242 MB | IVF_PQ / IVF_FLAT / HNSW_SQ / HNSW_PQ | `where()` 默认 pre-filter；内置 BM25 + RRF | 目录（Lance 文件） | 0.x API 变动；量化索引召回要调（见 3.3）；安装体积大 |
| **Chroma** | 3.5.0（2026-06-30） | Apache-2.0 | npm 包只是 REST 客户端，必须 `chroma run` 常驻 | HNSW（服务端） | 服务端 `where`；无 BM25 | 目录 | **Node 没有进程内模式**，PersistentClient 只有 Python |
| **Vectra** | 0.15.0（2026-05-24） | MIT | 纯 TS | 暴力余弦 | 评分前过滤；有 BM25 | 目录（JSON 分片） | 无 ANN；全量载入内存 |
| **Orama** | @orama/orama 3.1.18（2025-12-19） | Apache-2.0 | 纯 JS，零依赖 | 暴力（Map 全扫） | `where` 先出 ID 集；`mode: 'hybrid'` | 内存 + persistence 插件 | 全内存；10 个月未发版 |
| **DuckDB VSS** | 1.5.6（2026-09-28） | MIT | `@duckdb/node-api`，官方 napi 预编译 | HNSW | 默认 pre-filter；无内置融合 | `.duckdb` 文件 | 索引全在 RAM 且不占 memory_limit；checkpoint 全量重写 |
| **usearch** | 2.26.5（2026-10-18） | Apache-2.0 | napi 预编译 | HNSW / exact | **无过滤回调**，key 只能 BigInt | save / load / mmap | 没有 payload 和元数据过滤 |
| **hnswlib-node** | 3.0.0（2024-03-11） | Apache-2.0 | `install` 跑 node-gyp，无预编译 | HNSW | 无 | 单个 .dat | 要装 Xcode 编译；2.5 年未发版 |
| **faiss-node** | 0.5.1（2023-10-15） | MIT | prebuild-install，失败则本地编译 faiss | IVF / HNSW | 部分 | 手动序列化 | 3 年未更新 |
| **Zvec** | 0.7.1（2026-09-04） | Apache-2.0 | 官方 Node binding，预编译 darwin-arm64 | Flat / HNSW / DiskANN / IVF | 结构化 filter；内置 FTS + hybrid | 目录 + WAL | 2025-12 才开源，生态很新，写单进程独占 |
| **PGlite + pgvector** | 0.5.10（2026-10-14） | Apache-2.0 | 纯 WASM，无需编译 | pgvector 的 HNSW / IVFFlat | SQL WHERE | 目录 | WASM 单连接，比原生慢 |

真正影响选择的三条事实：

- **sqlite-vec 没有 ANN，这是设计现状不是配置问题。** 分区键能让它少扫一部分，但不是 HNSW。
- **Chroma 在 Node 上不能进程内持久化。** 官方 TS 文档要求连接 Chroma 服务端；`PersistentClient` 只在 Python 有。想用它就得接受一个常驻进程。
- **能在 Node 里真正进程内跑、带 ANN、带预编译的，只有 LanceDB、Zvec、DuckDB VSS、usearch 这几个。** 其中 usearch 没有元数据过滤，DuckDB 的索引占内存且写入要 checkpoint，Zvec 太新。LanceDB 是功能最齐的。

### 3.2 本地服务型

版本号取自 GitHub Release API，许可证读了各仓库 LICENSE，核实日 2026-10-19。

| 方案 | 最新版本 | 许可证 | macOS arm64 部署 | 资源下限 | 过滤 | 混合检索 | Node 客户端 | 主要限制 |
|---|---|---|---|---|---|---|---|---|
| Qdrant | 1.19.2（2026-10-05） | Apache-2.0 | 官方单二进制（28 MB），brew 无 | 空载约 200 MB | 支持 | 支持（prefetch + RRF/DBSF） | 官方 `@qdrant/js-client-rest` 1.19.0 | 向量常驻内存 |
| Milvus Lite | 3.2.2（2026-10-13） | Apache-2.0 | `pip install milvus-lite`，**仅 Python** | 约 300–800 MB | 支持 | 支持 | 仅真 Milvus 服务端有 Node SDK | 对 Node 宿主等同不可用 |
| Weaviate | 1.40.1（2026-10-13） | BSD-3-Clause（`wl/` 目录企业许可） | `brew install weaviate` | 1 GB 级 | 支持 | 内置 hybrid（BM25 + 向量） | 官方 `weaviate-client` 3.15.0（gRPC） | schema/备份自管 |
| Vespa | 8.763.13（2026-10-05） | Apache-2.0 | 只能 Docker 跑 Linux 容器 | 官方建议 ≥4 GB | 支持 | 支持，表达力最强 | 无官方 Node SDK | JVM，配置模型重 |
| pgvector | 0.8.7 | PostgreSQL License | 需要先有 Postgres（本机未装，brew 有 postgresql@17） | 100–200 MB + 索引 | SQL WHERE | 无内置融合，需自写 | 用 pg / postgres.js | 多维护一个 PG 实例 |
| Elasticsearch | 9.5.5（2026-10-06） | AGPLv3 / SSPLv1 / ELv2 三选一 | tar.gz 自带 JDK，brew 无 | JVM 堆 1 GB 起 | 支持 | 支持（kNN + RRF） | 官方 `@elastic/elasticsearch` | JVM 堆与 GC 是主要故障面 |
| OpenSearch | 3.9.0（2026-09-29） | Apache-2.0 | `brew install opensearch`（需 JDK） | 同上 | 支持 | 支持 | 官方 `@opensearch-project/opensearch` | JVM 重量级 |
| Redis | 8.10.2（2026-09-17） | 8.0 起可选 AGPLv3（此前 RSALv2/SSPLv1） | `brew install redis` | 约 50–100 MB | 支持 | 支持（FT.HYBRID） | 官方 `node-redis` | `maxmemory` 策略会静默淘汰向量 |
| Chroma | 1.5.9（2026-05-05） | Apache-2.0 | `chroma run --path`，CLI 带 macos-arm64 二进制 | 约 500 MB 级 | 支持 | 全文与向量都有，原生 hybrid 排序未核实 | 官方 `chromadb` 3.5.0（含 darwin-arm64 绑定） | server 模式演进中，版本迭代快 |

这张表里真正影响判断的是三件事：

- **Milvus Lite 只支持 Python。** 这一代是重写的纯 Python 实现，虽然能在本地起 gRPC server，但只实现了 pymilvus 的子集，Node 客户端没把握直连。对 dsh 插件来说等于不可用，除非额外维护 Python 进程。
- **JVM 方案（Vespa / ES / OpenSearch）不该进这个场景。** 单机、单用户、50 万 chunk 以内，为它扛一个 JVM 和堆调优没有收益；本机目前只有 Java 8，跑这些还得先装 JDK。
- **服务型里唯一值得考虑的是 Qdrant**：单个二进制（aarch64-apple-darwin 28 MB）、无 JVM、过滤和混合检索齐全、官方 Node 客户端。代价是向量常驻内存，以及多一个需要启动和监控的进程。

### 3.3 交叉实测：sqlite-vec、LanceDB、usearch

三套引擎跑同一批数据，全部进程内调用、单线程、k=10、L2。精确 top-10 用 float64 全量扫描独立算出；校验方式是 sqlite-vec 的暴力扫描对它的召回 = 1.000。

数据集两套，这个区别是整节的关键：
- **随机**：均匀分布向量，没有任何簇结构。
- **聚类**：带簇结构的向量，接近真实 embedding 的分布。

**表 A：10 万 × 384**

| 方案 | 数据 | 查询 p50 | 召回@10 |
|---|---|---|---|
| sqlite-vec 暴力扫描 | 随机 / 聚类 | 20.7 / 20.5 ms | 1.000 / 1.000 |
| LanceDB 无索引暴力 | 随机 | 10.5 ms | 1.000 |
| LanceDB IVF_FLAT（np=5） | 随机 | 1.2 ms | 0.362 |
| LanceDB IVF_FLAT（np=5） | 聚类 | 1.6 ms | **1.000** |
| LanceDB HNSW_SQ | 聚类 | 0.59 ms | 0.946 |
| LanceDB IVF_PQ（np=10） | 聚类 | 1.2 ms | **0.061** |
| usearch HNSW ef=32 | 随机 | 0.28 ms | 0.125 |
| usearch HNSW ef=256 | 随机 | 1.49 ms | 0.471 |
| usearch HNSW ef=32 | 聚类 | 0.10 ms | 0.989 |
| usearch HNSW ef=64 | 聚类 | 0.13 ms | 0.997 |
| usearch HNSW ef=256 | 聚类 | 0.39 ms | 0.999 |

**表 B：规模扩展**（随机数据，暴力扫描）

| 方案 | 10 万 × 768 | 50 万 × 384 |
|---|---|---|
| sqlite-vec（better-sqlite3） | 43.1 ms | 135.7 ms |
| LanceDB 无索引暴力 | 18.6 ms | 37.9 ms |
| usearch HNSW ef=256 | 2.79 ms（召回 0.424） | 2.23 ms（召回 0.247） |

**四条读法，每条都能改变实现方案：**

1. **数据有没有簇结构，决定 ANN 值不值得用。** 同一套 usearch HNSW 代码：随机数据把 ef 拉到 256 只有召回 0.471；聚类数据 ef=32 就有 0.989，延迟 0.10 ms，比暴力扫描快约 200 倍。随机高维空间里所有点近乎等距，图索引和量化都失去意义——这就是"随机向量=最坏情况"的具体表现。
2. **量化才是最大的陷阱，比选库重要。** 同一份聚类数据：IVF_FLAT 召回 1.000、HNSW_SQ 召回 0.946、IVF_PQ 召回 0.061。IVF_PQ 加 `refineFactor=10` 也只回到 0.524，因为真近邻根本没进 PQ 的候选集。所以看到"某库 1 ms 召回 99%"的说法，先问它有没有量化。
3. **"暴力扫描"换库能差 3.6 倍。** 50 万 × 384：LanceDB 37.9 ms，sqlite-vec 135.7 ms。LanceDB 是 Rust 多线程，sqlite-vec 是单线程 C 扩展。如果只是想要精确结果、又嫌慢，换库比建索引更省事。
4. **有簇结构时 IVF_FLAT 比 HNSW 划算。** 聚类数据上 IVF_FLAT 召回 1.000、1.6 ms，建索引只要 268 ms；usearch HNSW 召回 0.997、0.13 ms，但建索引 5.2 s，索引额外占 10% 体积且必须常驻内存。延迟差 12 倍，建索引成本差 20 倍，看你要哪个。

**其余横向数据**：

- 安装体积：sqlite-vec 原生包 168 KB；`@lancedb/lancedb` 的 darwin-arm64 包 242 MB，三个引擎装完 node_modules 690 MB，其中 `@lancedb` 一家 258 MB。
- LanceDB 读回向量返回的是 Arrow `Vector` 对象，要 `.toArray()` 才是 JS 数组，直接下标访问拿到 `undefined`——这个坑我踩了一次。
- 落盘：sqlite-vec 与原始向量体积基本相等；LanceDB 10 万 × 384 约 147–173 MB，50 万 × 384 约 736–864 MB，索引越大越占地方。

**没有测的**：真实 embedding 数据上的召回、并发写入、崩溃恢复、多进程同时打开同一个库、冷启动首次查询、过滤查询的召回率（只测了延迟）。

## 四、推荐

**默认选 sqlite-vec，条件是：10 万 chunk 以内、384 维、能接受单次查询 20–40 ms。**
可验证的理由：零原生编译（`node:sqlite` + 168 KB 的扩展）、精确结果、单文件、落盘等于向量原始大小、不需要调任何参数。用的时候把向量归一化、用默认 L2 别用 cosine，省 40%；插入量大就换 `better-sqlite3`，快 4 倍。

**下面任一条件成立时换 LanceDB：**超过 10 万 chunk、用 768 维、需要 BM25 + 向量的混合检索、或者单纯想更快。它的暴力扫描在 50 万 × 384 上 37.9 ms，比 sqlite-vec 快 3.6 倍；建索引就用 `Index.ivfFlat()`（聚类数据上召回 1.000 / 1.6 ms，建索引 268 ms），别用默认的 IVF_PQ。代价是 242 MB 的原生包和 0.x 的 API 变动。

**如果数据有明确的簇结构、且要极低延迟**，usearch 的 HNSW 是最快的（0.10–0.39 ms，召回 0.99 以上），代价是没有 payload 和元数据过滤、key 只能用 BigInt、建索引每 10 万条约 5 s。

**不建议在这个场景里考虑的：**
- Milvus Lite：只有 Python，Node 宿主用不上。
- Chroma：Node 端必须跑 `chroma run`，等于引入一个常驻服务。
- hnswlib-node、faiss-node：一个要 node-gyp 编译且 2.5 年没发版，一个 3 年没更新，在新 Node 上大概率装不上。
- Vespa / ES / OpenSearch：JVM，单机单用户场景是纯负担。

**如果确实需要独立服务**（多进程共享、远程访问），服务型里只推荐 Qdrant：单个 28 MB 二进制、无 JVM、有官方 Node 客户端、过滤和混合检索齐全。50 万 × 768 维的向量约 1.5 GB，这是它常驻内存的下限量级。

### 落地到 dsh 插件时的三个工程决定

1. **把同步查询挪出主线程。** `node:sqlite` 和 sqlite-vec 都是同步 API，20–190 ms 会直接阻塞 dsh 主进程。放进 `worker_threads`，或者把检索设计成"用户显式触发、不挂在每轮对话上"。
2. **过滤不要依赖 auxiliary column。** sqlite-vec 的 KNN 查询里对 `+列` 加 WHERE 会直接报错，只能用 `partition key`。分区键的代价是写入变慢（同样 10 万条 5.0 s vs 0.96 s），而且分区维度必须提前定好。
3. **先用真实数据量测一次再定实现。** 上表里随机数据和聚类数据的结论完全相反，真实 embedding 接近聚类那一列。手上没有真实数据时，先按"50 万条、768 维、LanceDB + IVF_FLAT"估，不要照随机数据的结论选。

## 五、参考

版本与许可证的核实方式：npm 包的版本/许可证取自 `registry.npmjs.org` 的 latest tag，GitHub 项目的版本取自 Release API，许可证读了各仓库 LICENSE 文件。核实日均为 2026-10-19。

- Node `node:sqlite`（`allowExtension` 与 `loadExtension` 自 v22.13.0 起提供）：<https://nodejs.org/docs/latest-v22.x/api/sqlite.html>
- sqlite-vec 项目：<https://github.com/asg017/sqlite-vec>
- sqlite-vec 仍是暴力扫描的依据（issue #25）：<https://github.com/asg017/sqlite-vec/issues/25>
- sqlite-vec 官方基准（SIFT1M 33 ms/查询）：<https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html>
- LanceDB Node 包：<https://www.npmjs.com/package/@lancedb/lancedb>
- LanceDB 索引类型文档：<https://lancedb.github.io/lancedb/concepts/index_ivfpq/>
- Chroma 的客户端/服务端模式说明：<https://docs.trychroma.com/docs/run-chroma/client-server>
- Chroma npm：<https://www.npmjs.com/package/chromadb>
- Milvus Lite（PyPI，仅 Python）：<https://pypi.org/project/milvus-lite/>
- Qdrant Release：<https://github.com/qdrant/qdrant/releases>
- Qdrant Node 客户端：<https://www.npmjs.com/package/@qdrant/js-client-rest>
- pgvector：<https://github.com/pgvector/pgvector>
- DuckDB VSS 扩展：<https://duckdb.org/docs/stable/core_extensions/vss>
- usearch：<https://www.npmjs.com/package/usearch>
- Zvec：<https://github.com/alibaba/zvec>
- PGlite：<https://www.npmjs.com/package/@electric-sql/pglite>
- Orama：<https://www.npmjs.com/package/@orama/orama>
- ann-benchmarks（公开基准，注意同页多曲线的口径差异）：<https://ann-benchmarks.com/>

实测脚本在 `/tmp/vecbench/`（三方案 × 三数据集，含 `bench_sqlite_vec.js`、`bench_lancedb.js`、`bench_lancedb_index_types.js`、`bench_usearch.js`，完整报告 `REPORT.md`）和 `/tmp/vecbench-lead/`（L2 与 cosine 对比、`node:sqlite` 与 `better-sqlite3` 对比、索引参数探针）。都是临时目录，不属于本仓库。
