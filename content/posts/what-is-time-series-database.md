---
title: "什么是时序数据库"
date: 2026-06-23
draft: false
categories: ["pg基础"]
tags: ["时序数据库", "Time Series", "PostgreSQL", "存储模型", "数据库"]
description: "从时序数据的定义和特点出发，整理时序数据库的写入、存储、查询和典型应用场景。"
summary: "时序数据库围绕时间戳和指标值组织数据，适合高频追加写入、时间范围查询、聚合分析和监控类场景。"
---
# 时序数据库探究

## 什么是时序数据

时序数据（Time Series Data）是按照时间顺序记录的数据集合，在一段时间内按照一定时间间隔或时间戳进行采集、记录或观测。

时序数据由两个主要部分组成：

- **时间戳**：表示数据点的时间点或时间段，可以是日期、时间、时间戳等形式
- **观测值**：在给定时间点上或时间段内测量或记录的数值、指标或事件

时序数据在许多领域中具有广泛的应用，例如金融市场分析、气象预测、交通流量监测、生产过程监控等。

![时序数据示例 - 地区风速风向](/images/posts/xuda/what-is-time-series-database/1.jpg)

## 时序数据的特点

1. **以时间为中心**：时间是主轴，数据记录总是有时间戳
2. **仅追加**：写入的数据几乎是新数据，总是执行 INSERT 操作；UPDATE 和 DELETE 是异常操作
3. **时间相邻**：数据按时间顺序写入，新数据与最近的时间间隔有关，很少回填旧数据

## 存储方式对比

### 行存储的问题

假设有这样的数据：

```sql
time   cpu
10:00  30
10:01  31
10:02  30
```

查询 10:00~10:02 的 cpu 时，行存必须逐行读取：

- 读 10:00 行 → 拿 cpu
- 读 10:01 行 → 拿 cpu
- 读 10:02 行 → 拿 cpu

每行都有 time、cpu 及其他列，导致 CPU cache 利用率差，IO 浪费。

### 列存储的优势

```sql
time: [10:00, 10:01, 10:02]
cpu:  [30, 31, 30]
```

查询时直接截取 cpu 数组对应片段 `[30, 31, 30]`：

- 不读时间列、不读其他列
- 数组连续 → CPU cache 友好，IO 顺序读
- 压缩后更小 → IO 更少

### 主流时序数据库对比

| 系统        | 存储方式     | 适合场景        | 优势                                   |
| ----------- | ------------ | --------------- | -------------------------------------- |
| Prometheus  | 列存 + chunk | 高速监控数据    | 压缩好，聚合快                         |
| InfluxDB    | 列存 + TSM   | 高速时序数据    | 压缩好，聚合快                         |
| TimescaleDB | 行存 + chunk | 兼顾 SQL / 时序 | 可以复用 PostgreSQL 生态，查询功能丰富 |

## 时序数据库的内核设计

### 存储引擎的选择

时序数据库在存储引擎层面有两种主流方案：

#### 1. LSM-Tree（Log-Structured Merge-Tree）

**代表**：InfluxDB、OpenTSDB

**核心思想**：

- 写入时先写 WAL（Write-Ahead Log），再写内存表（MemTable）
- 内存表满后刷盘成 SSTable（Sorted String Table）
- 后台定期合并（Compaction）多个 SSTable

**优势**：

- 顺序写入，写性能极高
- 适合写多读少的场景

**劣势**：

- 读放大：可能需要查询多个 SSTable
- 写放大：Compaction 会重写数据
- 空间放大：旧版本数据未及时清理

#### 2. B-Tree + 分区表

**代表**：TimescaleDB、PostgreSQL

**核心思想**：

- 使用传统 B-Tree 索引
- 按时间分区（Partitioning）减少扫描范围
- 利用 MVCC 实现并发控制

**优势**：

- 读写平衡，支持复杂查询
- 事务支持完善
- 生态成熟

**劣势**：

- 写入性能不如 LSM-Tree
- 需要定期维护索引

## TimescaleDB 的内核实现

TimescaleDB 是 PostgreSQL 的扩展（Extension），在不修改 PostgreSQL 内核的前提下，通过 Hook 机制实现了时序数据库的核心功能。

### 1. Hypertable 的实现原理

#### 元数据管理

TimescaleDB 在系统表中维护 Hypertable 的元数据：

```sql
-- _timescaledb_catalog.hypertable
-- 记录 Hypertable 的定义
id | schema_name | table_name | chunk_sizing_func | ...

-- _timescaledb_catalog.chunk
-- 记录每个 chunk 的信息
id | hypertable_id | schema_name | table_name | ...

-- _timescaledb_catalog.dimension
-- 记录分区维度（时间列、空间列）
id | hypertable_id | column_name | interval_length | ...
```

#### Chunk 的自动创建

当插入数据时，TimescaleDB 通过 **Trigger** 或 **Planner Hook** 拦截：

1. 根据时间戳计算应该写入哪个 chunk
2. 如果 chunk 不存在，自动创建新的子表
3. 设置子表的 CHECK 约束（时间范围）
4. 继承父表（Hypertable）
5. 创建索引

```sql
-- 自动生成的 chunk 示例
CREATE TABLE _timescaledb_internal._hyper_1_1_chunk (
    CHECK (time >= '2024-01-01' AND time < '2024-01-08')
) INHERITS (metrics);

CREATE INDEX ON _timescaledb_internal._hyper_1_1_chunk (time DESC);
```

#### 查询路由（Constraint Exclusion）

PostgreSQL 的 **Constraint Exclusion** 机制：

```sql
SELECT * FROM metrics WHERE time BETWEEN '2024-01-05' AND '2024-01-10';
```

查询计划器会：

1. 检查每个 chunk 的 CHECK 约束
2. 排除时间范围不匹配的 chunk
3. 只扫描相关的 chunk

```
Append
  -> Seq Scan on _hyper_1_1_chunk  (time: 2024-01-01 ~ 2024-01-08)
  -> Seq Scan on _hyper_1_2_chunk  (time: 2024-01-08 ~ 2024-01-15)
```

### 2. 列式压缩的实现

#### 压缩算法

TimescaleDB 对不同数据类型使用不同的压缩算法：

| 数据类型 | 压缩算法           | 原理                                   |
| -------- | ------------------ | -------------------------------------- |
| 时间戳   | Delta-of-Delta     | 存储时间差的差值，利用时间间隔的规律性 |
| 整数     | Simple8b / Gorilla | 变长编码 + 位打包                      |
| 浮点数   | Gorilla            | XOR 编码，利用相邻值的相似性           |
| 字符串   | Dictionary         | 字典编码，重复字符串只存一次           |

#### 压缩流程

1. **选择待压缩的 chunk**：通常是旧的、不再写入的 chunk
2. **按列重组数据**：将行存数据转换为列存格式
3. **应用压缩算法**：对每列独立压缩
4. **存储压缩元数据**：记录压缩后的段（segment）信息
5. **删除原始数据**：释放空间

```sql
-- 压缩后的存储结构
_timescaledb_internal.compress_hyper_2_3_chunk
  - segment_by: device_id  -- 分段键
  - order_by: time DESC    -- 排序键
  - compressed columns: time, cpu, memory, ...
```

#### 查询时的解压

查询压缩数据时，TimescaleDB 通过 **Custom Scan Node** 实现透明解压：

```
Custom Scan (DecompressChunk)
  -> Seq Scan on compress_hyper_2_3_chunk
       Filter: (device_id = 'server1')
```

解压过程：

1. 读取压缩的列数据
2. 按需解压（只解压查询涉及的列）
3. 应用过滤条件
4. 返回结果

### 3. 索引优化

#### 时间列索引

TimescaleDB 默认在时间列上创建 **B-Tree 索引**，并使用 **DESC** 排序：

```sql
CREATE INDEX ON metrics (time DESC);
```

原因：

- 时序查询通常是"最近的数据"
- DESC 索引让最新数据在索引的前面，减少 IO

#### 复合索引

对于多维查询（时间 + 标签），使用复合索引：

```sql
CREATE INDEX ON metrics (device_id, time DESC);
```

查询计划器可以利用索引快速定位：

```sql
SELECT * FROM metrics 
WHERE device_id = 'server1' 
  AND time > NOW() - INTERVAL '1 hour';
```

#### BRIN 索引（Block Range Index）

对于大表，可以使用 BRIN 索引：

```sql
CREATE INDEX ON metrics USING BRIN (time);
```

**优势**：

- 索引体积极小（只记录每个数据块的最小/最大值）
- 适合时间列（天然有序）

**劣势**：

- 精度较低，可能扫描额外的数据块

### 4. 连续聚合的实现

#### 增量物化视图

传统物化视图的问题：

- 全量刷新，代价高
- 无法实时更新

TimescaleDB 的连续聚合通过 **增量更新** 解决：

```sql
CREATE MATERIALIZED VIEW metrics_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS hour,
       device_id,
       AVG(cpu) AS avg_cpu
FROM metrics
GROUP BY hour, device_id;
```

#### 实现机制

1. **Watermark（水位线）**：记录已聚合的时间点
2. **Invalidation Log**：记录哪些时间段的数据被修改
3. **后台任务**：定期扫描新数据和失效数据，增量更新视图

```
Watermark: 2024-01-19 10:00

新数据: 2024-01-19 10:00 ~ 11:00
  -> 计算这 1 小时的聚合
  -> 插入到物化视图
  -> 更新 Watermark 到 11:00

修改数据: 2024-01-19 09:30 的某条记录被 UPDATE
  -> Invalidation Log 记录 09:00 ~ 10:00 失效
  -> 重新计算这 1 小时的聚合
  -> 更新物化视图
```

#### 查询改写

查询连续聚合时，TimescaleDB 会自动改写查询计划：

```sql
-- 用户查询
SELECT hour, AVG(avg_cpu) FROM metrics_hourly
WHERE hour > NOW() - INTERVAL '7 days'
GROUP BY hour;

-- 实际执行
SELECT hour, AVG(avg_cpu) FROM _timescaledb_internal._materialized_hypertable_2
WHERE hour > NOW() - INTERVAL '7 days'
GROUP BY hour;
```

### 5. 写入优化

#### 批量插入

TimescaleDB 通过 **Batch Insert** 减少事务开销：

```c
// 伪代码
if (batch_size < max_batch_size) {
    buffer[batch_size++] = row;
} else {
    flush_batch(buffer, batch_size);
    batch_size = 0;
}
```

#### 并行写入

多个 chunk 可以并行写入：

- 不同时间范围的数据写入不同 chunk
- 每个 chunk 是独立的表，锁粒度小
- 避免单表写入的锁竞争

#### WAL 优化

PostgreSQL 的 WAL 机制保证持久性，但会影响写入性能。优化方法：

- 调整 `wal_buffers` 和 `checkpoint_timeout`
- 使用 `synchronous_commit = off`（牺牲部分持久性）
- 使用 `UNLOGGED` 表（不写 WAL，重启后数据丢失）

### 6. 查询优化

#### Parallel Query

TimescaleDB 支持 PostgreSQL 的并行查询：

```sql
SET max_parallel_workers_per_gather = 4;

SELECT time_bucket('1 hour', time), AVG(cpu)
FROM metrics
WHERE time > NOW() - INTERVAL '30 days'
GROUP BY 1;
```

查询计划：

```
Finalize GroupAggregate
  -> Gather
       Workers Planned: 4
       -> Partial GroupAggregate
            -> Parallel Append
                 -> Parallel Seq Scan on _hyper_1_1_chunk
                 -> Parallel Seq Scan on _hyper_1_2_chunk
                 ...
```

#### JIT 编译

PostgreSQL 11+ 支持 JIT（Just-In-Time）编译，加速表达式计算：

```sql
SET jit = on;
```

对于复杂的聚合查询，JIT 可以显著提升性能。

#### 统计信息

TimescaleDB 维护每个 chunk 的统计信息：

- 行数估算
- 列的最小/最大值
- 数据分布直方图

查询计划器根据统计信息选择最优执行计划。

## 总结

从内核角度看，TimescaleDB 的核心设计包括：

1. **分区表 + B-Tree**：利用 PostgreSQL 的分区和索引机制
2. **自动 Chunk 管理**：通过元数据和 Hook 实现透明分区
3. **列式压缩**：混合行存和列存，兼顾写入和查询
4. **增量物化视图**：通过 Watermark 和 Invalidation Log 实现高效聚合
5. **查询优化**：Constraint Exclusion、并行查询、JIT 编译

相比纯时序数据库（LSM-Tree），TimescaleDB 牺牲了部分写入性能，但获得了更强的查询能力和事务支持；相比传统关系型数据库，通过分区和压缩大幅提升了时序数据的处理效率。
