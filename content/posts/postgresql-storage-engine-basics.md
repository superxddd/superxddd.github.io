---
title: "PostgreSQL 存储引擎基础"
date: 2026-06-23
draft: false
categories: ["pg基础"]
tags: ["PostgreSQL", "存储引擎", "Heap", "Page", "Tuple", "MVCC", "数据库内核"]
description: "从建表、堆文件、page、tuple、MVCC、HOT、VACUUM 等角度梳理 PostgreSQL 存储引擎基础。"
summary: "沿着表到堆文件、page、tuple 与 MVCC 的链路，建立 PostgreSQL 存储引擎的整体视图。"
---
PostgreSQL 存储引擎整体总结

---

## 0. 一条从上到下的时间线

这里先用一个非常粗略的时间线，把后面会展开的所有概念串起来：

1. **建表**：`CREATE TABLE mytable (...)`，系统在 `pg_class` / `pg_database` 中登记 OID，并在 `$PGDATA/base/数据库OID/表OID` 下准备堆文件。
2. **第一次插入数据**：插第一条记录时，表文件从 0KB 变成 8KB，说明分配了第一个 page。
3. **持续插入**：不断向已有 page 写入 tuple，写满后在文件末尾追加新 page，堆文件逐步接近 1GB。
4. **超过 1GB**：当前堆文件满了，新建 `表OID.1`、`表OID.2` … 等堆文件继续存放 page。
5. **更新 / 删除行**：不会立刻物理删除 tuple，而是把旧 tuple 标记为“墓碑”，并插入新版本（MVCC）。
6. **大量 UPDATE 时**：尽量使用 HOT，在 heap 里通过 `t_ctid` 串起版本链，减少索引更新。
7. **VACUUM / 自动清理**：扫描 page，把 `LP_DEAD` 的墓碑回收成 `LP_UNUSED`，维护 FSM/VM 等信息，保证后续插入能重用空间。

---

## 0.5 存储引擎整体架构鸟瞰

这篇笔记当前重点在“**表 → 堆文件 → page → tuple → MVCC/HOT**”这一条链上，其实完整的存储引擎还包括几层重要组件，可以简单先有个全局图：

- **逻辑对象层（对 DBA/开发者可见）**
  - 数据库（`pg_database`）、表空间（tablespace）、schema、表、索引、物化视图等。
  - 这些对象的元数据保存在系统表里（`pg_class`、`pg_attribute` 等），并通过 OID/relfilenode 映射到物理文件。

- **物理存储层（本笔记重点）**
  - **关系文件（relation file）**：
    - heap 表文件（本篇大部分内容）、各种索引文件（B-Tree、Hash、GIN、GiST 等）、TOAST 表文件。
    - 每个关系通常有多个“fork”：`main`（主数据）、`fsm`（Free Space Map）、`vm`（Visibility Map）、`init` 等。
  - **分段与 page**：
    - 每个 fork 又被切成若干 1GB segment 文件，每个 segment 由很多 8KB page 组成。

- **缓冲管理层（Buffer Manager）**
  - Shared Buffer（共享缓冲池）是所有进程访问 page 的前置层：
    - 读时：先在 Buffer 里找，不在才从文件读 page 进内存。
    - 写时：修改发生在 Buffer 中，然后由后台进程刷入磁盘。
  - 内部有自己的淘汰算法（clock-sweep 等），和检查点（checkpoint）配合控制刷盘节奏。

- **WAL / 持久化与崩溃恢复层**
  - 所有对数据页的修改都会先写入 **WAL 日志**（预写式日志）：
    - 确保即使宕机，也可以通过 WAL 回放恢复到一致状态。
  - Checkpointer / WAL Writer 等后台进程负责：
    - 定期把脏页从 Buffer 刷到堆文件 / 索引文件。
    - 保证 “WAL 永远先于数据页持久化” 的约束。

- **空间与可见性管理层**
  - **FSM（Free Space Map）**：记录哪些 heap page 还有空间可用，支持插入时快速定位可插入 page。
  - **VM（Visibility Map）**：记录哪些 page 上所有 tuple 对所有事务都可见，用于：
    - 加速 Index Only Scan，
    - 减少 VACUUM 必须扫描的 page 数量。
  - **VACUUM / Autovacuum**：
    - 负责清理死 tuple（墓碑）、更新 FSM/VM，防止膨胀。

- **大字段与 TOAST 子系统**
  - 当某一行中的某些字段太大（TEXT、BYTEA 等），会被拆分到 TOAST 表中。
  - 主表中只保留指向 TOAST 数据的“引用”，TOAST 表本身就是一张特殊的 heap 表。

> 本文后续的章节主要是在“物理存储层（heap + page + tuple + MVCC/HOT）”这一块打深度，有了这张鸟瞰图之后，page/tuple 等概念在整个系统里的位置会更清晰一些。

---

## 一、从表到堆文件：逻辑对象如何落到磁盘

- **表与堆文件（heap file）的对应关系**
  - 在 PostgreSQL 中，每个 `TABLE` 会被一个或多个堆文件表示。
  - 单个堆文件的默认最大大小为 **1GB**。
  - 当第一个堆文件达到 1GB 后，再有数据写入时，会创建新的堆文件：
    - 第一个文件名：`表 OID`
    - 后续文件名：`表 OID.1`、`表 OID.2`、`表 OID.3`……
  - 示例：逻辑表到堆文件的映射示意图：
  - ![表到堆文件示意图](/images/posts/xuda/postgresql-storage-engine-basics/v2-dab28219c0b9c149c2edab1161483463_1440w.jpg)

- **数据库 / 表 OID 与物理路径**
  - PostgreSQL 内部用 **OID（Object ID）** 标识数据库、表等对象，而不是直接用名字。
  - OID 本质是一个无符号整型：
    - `typedef unsigned int Oid;`
  - 常用 SQL 查询：
    - 查询某表的 OID 与 `relfilenode`：
      ```sql
      SELECT oid, relfilenode
      FROM pg_class
      WHERE relname = 'mytable';
      ```
    - 查询当前数据库的 OID：
      ```sql
      SELECT oid
      FROM pg_database
      WHERE datname = current_database();
      ```
  - 数据文件的大致路径：
    - **`$PGDATA/base/数据库OID/表OID[.序号]`**
  - 可以结合图形化工具（例如光华提供的软件）查看数据库 OID / 表文件对应关系：
    ![页面示意图](/images/posts/xuda/postgresql-storage-engine-basics/image-20251117174956996.jpg)

- **第一次插入数据时才真正分配页**
  - 刚建表时，在数据目录下可以看到对应的表文件，但大小一般为 0KB。
  - 插入**第一条**记录后，再查看文件大小，会发现变为 **8KB**：
    - 说明 PostgreSQL 是在真正插入数据时，才分配第一个物理页（page）。

---

## 二、从堆文件到 page/block：8KB 的基本读写单位

- **page/block 的含义**
  - PostgreSQL 把表和索引都视为 **固定大小 page 的数组**。
  - 默认 page 大小为 **8KB（8192 字节）**：
    - 这是在编译时确定的，集群初始化后就固定。
  - page 既是**磁盘**的读写单位，也是**缓存**中的基本单位。

- **1GB 文件中 page 的数量**
  - 1GB = 1024 MB = 1024 × 1024 KB
  - page 大小 = 8KB
  - 一个堆文件中 page 数量：
    - \[ \(1024 × 1024 KB\) / 8KB = 131072 个 page \]
  - 不仅普通堆文件（表数据），其他如索引文件、FSM 文件（Free Space Map）、VM 文件（Visibility Map）等，也都是由固定大小的 page 组成。

- **page 的编号与扩展**
  - 每个堆文件内部的 page 从 **0 开始编号**，称为 **block number**。
  - 当某个 page 被写满时：
    - 在文件末尾追加一个新的空白 page。
  - 当当前堆文件达到 1GB 大小时：
    - 创建新的堆文件（`表OID.1`、`表OID.2`…），继续追加 page。
  - 堆文件中 page 连续排布的大致示意图：
    ![堆文件 page 切分示意图](/images/posts/xuda/postgresql-storage-engine-basics/v2-9898188abe11ab5ac9b918a85d0f48d6_1440w.jpg)

---

## 三、page 内部结构：从页头到 tuple 数据

- **标准 heap/index page 的四个区域**
  - 一个典型的 page 可以划分为四部分：
    1. **page 头部区域**
       - 描述整个 page 的状态，如空闲空间起止位置、校验值等。
    2. **数据指针区域（line pointer 数组）**
       - 保存一个数组，每个元素指向一个 tuple 的位置和长度。
       - 相当于“目录表”/“索引”，本身不存放实际 tuple 数据。
    3. **数据区域（tuple data）**
       - 真实的行记录（tuple）存放在这里。
    4. **特殊区域（special area）**
       - 用于索引等特殊用途（例如 B-Tree 页中的额外信息）。
  - 页面整体布局示意图（指针区向下长，数据区向上长）：
    ![页内结构示意图](/images/posts/xuda/postgresql-storage-engine-basics/d8c18abd823849538bc4c9f10fbda36f.jpg)

- **指针区域与数据区域的“对顶生长”**
  - **指针区域**：
    - 从 page 上方向下增长（`pd_lower` 向下移动）。
  - **数据区域**：
    - 从 page 底部向上增长（`pd_upper` 向上移动）。
  - 中间的空间是“空闲空间”，只要：
    - `pd_upper - pd_lower >= 需要的空间`
    - 就可以继续插入新 tuple。

- **插入 tuple 时的空间检查逻辑**
  - 插入一条新的 tuple 需要的空间：
    - `required_space = tuple_size + sizeof(ItemIdData)`
  - 判断条件：
    ```c
    required_space = tuple_size + sizeof(ItemIdData);
    if (pd_upper - pd_lower < required_space)
        page_full -> need new page;
    ```
  - 当前 page 空间不足时，需要：
    - 在同一文件中选择其他 page，或
    - 在文件末尾创建新 page（必要时创建新堆文件）。

---

## 四、line pointer 的状态与简单删除模型

- **line pointer 的作用**
  - 每条 line pointer 指向一个 tuple 的位置和长度。
  - 同时携带状态位，表示对应 tuple 的生命周期状态。

- **常见的 line pointer 状态**
  - **`LP_UNUSED`**
    - 空闲 slot，可用于插入新的 tuple。
  - **`LP_NORMAL`**
    - 指向一个正常、有效的 tuple。
  - **`LP_DEAD`**
    - 对应的 tuple 已死（被逻辑删除或被 HOT 更新为旧版本）。
    - 可以被 VACUUM 或 HOT 回收利用。
  - **`LP_FIRST_HALF`**
    - 用于跨页 tuple 或 TOAST 分页场景，指向 tuple 的前半部分等特殊情况。

- **删除 tuple 的“墓碑机制”**
  - 删除一个 tuple 时，并不会立刻把它从 page 中物理移除：
    1. tuple 头部的 `t_xmax` 被设置为执行删除的事务 XID。
    2. tuple 实体仍然保留在 page 上，只是对普通事务不再可见。
    3. line pointer 仍指向该 tuple，但会被标记为 **`LP_DEAD`**。
  - 之后，VACUUM 或 HOT 清理时：
    - 回收该 dead tuple 占用的空间，
    - line pointer 状态从 `LP_DEAD` 变为 `LP_UNUSED`。
  - 这就形成了所谓的 **“墓碑机制”**：
    - 逻辑上被删除的 tuple，短时间内以墓碑形式存在，便于并发控制和后续清理。

---

## 五、tuple 结构：从逻辑行到物理存储

- **tuple 的物理结构**
  - 在页面 / 磁盘层面，每条行记录（row）对应的物理结构是：
    - **`HeapTupleHeader`（tuple 头部）**
    - **实际数据字段（payload）**
  - 头部中包含：
    - 事务可见性信息（如 `t_xmin`、`t_xmax`）
    - 指向下一版本的指针（如 `t_ctid`），在 HOT 链中非常关键。

- **逻辑行与物理 tuple 的关系**
  - 应用层看到的是“行记录（row）”概念。
  - 存储层在 page 中以 `(HeapTupleHeader + data)` 的形式组织。
  - 一条逻辑行在不同时间可能对应 **多个物理 tuple**（多版本）。

### tuple 的几个类别（简单印象）

- 从“存储引擎基础”的角度，可以先有一个模糊分类印象：
  - **Heap tuple**：普通表数据行，在 heap page 上以 `HeapTupleHeader + data` 形式存放。
  - **Index tuple**：存放在索引 page 上，包含索引键值 + 指向 heap tuple 的 `t_ctid`。
  - **TOAST tuple**：针对大字段（TEXT / BYTEA 等）拆分出来的“外部存储”片段，也用类似 page+tuple 的方式管理。
- 这一分类在后续理解索引扫描、索引只读（Index Only Scan）、TOAST 机制时会很有用。

---

## 六、MVCC：多版本并发控制的基础

- **UPDATE 的本质：INSERT 新版本 + 标记旧版本**
  - PostgreSQL 实现 MVCC 的方式：
    - **UPDATE 并不会覆盖旧 tuple**，
    - 而是：
      1. 给旧 tuple 的头部写入 `t_xmax` 等信息，标记为“旧版本/删除”。
      2. 插入一个新的 tuple，作为该行的最新版本。
  - 结果：
    - 同一逻辑行在同一表中存在多个版本（tuple）。
    - 不同事务根据自己的快照规则（事务号、可见性判断）决定看到哪个版本。

- **传统 UPDATE 的代价**
  - 在早期实现中，UPDATE 近似为“DELETE + INSERT”：
    - 删除旧 tuple，
    - 插入新 tuple，
    - 同时对所有相关索引都进行更新。
  - 大量 UPDATE 场景下：
    - 频繁修改索引（尤其是 B-Tree）会导致：
      - 页分裂增多，
      - 索引膨胀，
      - 写放大严重，
      - 性能明显下降。

### 可见性判断简要流程

- 每个 tuple 头部都有 `t_xmin` 和 `t_xmax`：
  - `t_xmin`：插入该 tuple 的事务号。
  - `t_xmax`：删除 / 覆盖该 tuple 的事务号（如果为空，表示尚未被删除）。
- 每个事务在开始时会生成一个 **快照（snapshot）**，里面记录：
  - 自己的事务号，
  - 已提交事务的高水位线，
  - 某个区间内“正在运行的事务列表”等。
- 对某个 tuple 是否可见的粗略判断逻辑：
  - 插入事务（`t_xmin`）必须对当前快照来说是“已提交且不比我晚”；
  - 删除事务（`t_xmax`）要么不存在，要么对当前快照来说“尚未提交 / 不可见”。
- 真实代码逻辑更复杂（还涉及 hint bits、冻结等），这里先保留直觉：  
  **“可见性 = 当前事务的快照规则 + tuple 头上的事务号”。**

### VACUUM / FSM / VM 在空间回收中的角色

- **VACUUM 的核心作用**
  - 扫描 heap page，找出对任何事务都不可见的 dead tuple。
  - 把这些 dead tuple 占用的空间回收，并更新相关元信息。
  - 把对应 line pointer 从 `LP_DEAD` 改为 `LP_UNUSED`，为后续插入腾出 slot。
- **FSM（Free Space Map）**
  - 记录每个 heap page 上还剩多少可用空间。
  - 插入新 tuple 时，可以利用 FSM 快速定位“有空闲空间的 page”，而不是从头扫。
- **VM（Visibility Map）**
  - 标记哪些 page 上的所有 tuple 对所有事务都可见。
  - 用于加速 Index Only Scan、减少 VACUUM 扫描量等。
- 把它们放在前面的时间线里就是：
  - **删除 / 更新 → 产生墓碑 → VACUUM + FSM/VM 更新 → 后续插入重用空间。**

---

## 七、HOT（Heap Only Tuple）：减少索引更新的多版本链

- **HOT 的动机**
  - 目标：在 UPDATE 时，**尽量避免对索引进行修改**。
  - 适用场景：更新的列 **不影响索引键值**，可以复用原索引项。

- **索引中的位置信息：t_ctid**
  - 索引项（例如 B-Tree）中保存指向表中 tuple 的位置：
    - `t_ctid = (ip_block, ip_posid)`
      - `ip_block`：页号（block number）。
      - `ip_posid`：该页中 line pointer 的下标。
  - 通过 `t_ctid` 可以找到 page 内的具体 tuple。

- **HOT 更新的核心机制**
  - 在满足条件（例如不修改索引列）的 UPDATE 中：
    - **不新增新的索引项**。
    - 保持索引里的 `t_ctid` 指向链表的“入口”。
  - 更新时的链式结构：
    - 对同一逻辑行，多个版本通过 `t_ctid` 串成链：
      - **索引 → tuple1(dead) → tuple2(dead) → tuple3(live)**。
    - 查询时，通过索引找到链头，再顺着链找到当前事务可见的最新版本。

- **HOT 链和 line pointer 状态的关系**
  - 链中的旧版本 tuple 通常会被标记为“dead”：
    - 对应的 line pointer 状态为 `LP_DEAD`。
  - 当 VACUUM/HOT 清理这些旧版本时：
    - 回收其空间，
    - 把对应指针变为 `LP_UNUSED`。
  - HOT 的关键收益：
    - 对“只修改非索引列”的 UPDATE，大部分情况下只在 heap（堆）上追加新 tuple，并串入 HOT 链，
    - **索引结构不需要频繁更新**，从而大幅减小 UPDATE 带来的索引写入压力。

---

## 八、整体串联：从表到 page，再到 MVCC/HOT

按时间、逻辑顺序，可以把 PostgreSQL 存储引擎的关键知识串成一条线：

1. **从 SQL 到文件**
   - `CREATE TABLE` 创建逻辑表对象。
   - 内部为表、数据库分配 OID。
   - 在 `$PGDATA/base/数据库OID/表OID[.序号]` 下创建对应堆文件。

2. **从文件到 page**
   - 堆文件被切分为固定大小的 8KB page。
   - 每个 page 以 block number（0 开始）编号。
   - 插入数据时，按 page 为单位分配和写入。

3. **从 page 到 tuple**
   - page 内部：页头 + line pointer 数组 + tuple data + special 区域。
   - line pointer 管理 tuple 的位置和生命周期状态。
   - 插入时检查 `pd_upper - pd_lower`，不足则使用新的 page。

4. **从 tuple 到墓碑**
   - 删除 / 更新并不立即物理删除 tuple。
   - 通过 tuple 头部的事务信息 + `LP_DEAD` 状态形成“墓碑”。
   - VACUUM 或 HOT 回收后，指针变 `LP_UNUSED`，空间可重用。

5. **从墓碑到 HOT 链（多版本）**
   - MVCC：UPDATE = 标记旧版本 + 插入新版本。
   - 为减少索引修改，HOT 通过 `t_ctid` 把多个版本串成链：
     - 索引始终指向链头。
     - 链中只有最后一个版本是“当前有效版本”，前面是历史版本。




