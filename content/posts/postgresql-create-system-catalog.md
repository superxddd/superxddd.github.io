---
title: "如何创建一个 PostgreSQL 系统表"
date: 2026-06-23
draft: false
categories: ["pg基础"]
tags: ["PostgreSQL", "系统表", "System Catalog", "initdb", "BKI", "数据库内核"]
description: "以 pg_my_catalog 为例，整理 PostgreSQL 新增系统目录表所需的源码改动、BKI 生成流程和 initdb 注意事项。"
summary: "新增系统表需要进入 postgres.bki 生成流程，并通过 initdb 初始化新集群后才能生效。"
---
# 如何创建一个系统表（以 `pg_my_catalog` 为例）

本文面向 **PostgreSQL 源码二次开发/内核开发** 场景：当你需要新增一张 **系统目录表（system catalog）** 并让它在 `initdb` 初始化集群时被创建。

> **新增系统表不是“在线 DDL”**。你必须让它进入 `postgres.bki` 的生成流程，并对**新集群**执行 `initdb` 才能看到它。

## 01 系统表概念

PostgreSQL 的系统目录（System Catalogs）用于保存数据库对象的 **元数据**（定义、关系、权限、统计信息等）。它们主要位于 `pg_catalog` 模式中。

### 1.1 常见元数据类型

- **数据库对象信息**
  - `pg_database`：数据库信息
  - `pg_class`：表/索引/序列/视图等关系对象的元数据
  - `pg_proc`：函数定义
  - `pg_type`：数据类型
  - `pg_operator`：操作符定义
  - `pg_trigger`：触发器
  - `pg_constraint`：约束

- **对象间关系管理**
  - `pg_attribute`：表的列定义及其类型
  - `pg_depend`：对象依赖（例如视图依赖基表）
  - `pg_inherits`：表继承关系

- **访问权限控制**
  - `pg_authid`：角色信息
  - `pg_default_acl`：默认权限规则

- **统计信息存储**
  - `pg_statistic`：列级统计信息
  - `pg_statistic_ext`：扩展统计信息

### 1.2 系统表的作用范围

系统表根据作用范围可分为两类：

- **实例级别（全局系统表）**
  - **存储位置**：`$PGDATA/global/`
  - **特点**：所有数据库共享同一份数据
  - **表空间**：`pg_global`
  - **主要内容**：数据库、表空间、复制源、角色、参数权限等全局共享对象

- **数据库级别（数据库级系统表）**
  - **存储位置**：`$PGDATA/base/<数据库OID>/`
  - **特点**：每个数据库一份
  - **表空间**：`pg_default`
  - **主要内容**：表、索引、函数、类型等数据库特定对象

![image-20260119173153237](/images/posts/xuda/postgresql-create-system-catalog/image-20260119173153237.png)

## 02 系统表初始化原理

### 2.1 为什么系统表不能用 SQL 直接创建？

用户创建表等对象走的是 SQL 引擎，但系统表本身是 SQL 引擎运行所依赖的“元数据底座”，因此会遇到经典的“鸡生蛋”问题：

**如果系统表尚不存在，SQL 引擎依赖什么去解析/执行创建系统表的 SQL？**

例如 `pg_class` 记录了所有关系对象的元数据，而 `pg_class` 自己也是一张表；要创建 `pg_class`，又需要先能往 `pg_class` 写入它自己的那条元数据记录，这显然矛盾。

### 2.2 BKI（Backend Interface）引导机制

PostgreSQL 通过 BKI（Backend Interface）脚本配合 **Bootstrap 模式**解决“无表环境下建表”的问题：

- **Bootstrap 模式**：允许执行极小化命令集（BKI），创建最基础的 catalog 并插入必要的初始行
- **普通 SQL 模式**：要求系统表已存在，才能解析/执行 SQL

### 2.3 `postgres.bki` 的生成与执行

引导脚本 `postgres.bki` 的生成与使用链路：

1. **生成阶段**：`src/backend/catalog/genbki.pl` + `src/backend/catalog/catalog.pm`
2. **输入来源**：`src/include/catalog/` 下的系统表定义头文件（`.h`）以及初始数据文件（`.dat`）
3. **输出位置**：安装目录的 `share/postgres.bki`
4. **执行时机**：`initdb` 创建新集群时执行，用于创建并初始化系统表

### 2.4 初始化分阶段：Bootstrap vs Post-bootstrap

整体初始化通常分两段：

- **Bootstrap 阶段（BKI）**
  - 创建基础 catalog，并插入必要的初始行
  - 解决“鸡生蛋”问题

- **Post-bootstrap 阶段（SQL）**
  - 执行 SQL 脚本补齐“高层对象”，如函数/视图/信息模式：`system_functions.sql`、`system_views.sql`、`information_schema.sql` 等

### 2.5 OID 分配规则（理解即可）

PostgreSQL 对初始化阶段相关对象的 OID 通常有以下划分（用于理解为什么要挑 OID）：

- **0-9999**：固定写死的 OID，多用于最核心对象（系统表/索引/字段等）
- **10000-11999**：`genbki.pl` 在生成 `postgres.bki` 时自动分配给某些 `.dat` 初始行（当该表有 OID 列但 `.dat` 未显式给 OID）
- **12000-16383**：保留给 Post-bootstrap 阶段（SQL 脚本创建的对象，如视图/函数等）

详情参考 `src/include/access/transam.h` 附近注释

![image-20260119175401141](/images/posts/xuda/postgresql-create-system-catalog/image-20260119175401141.png)

## 03 实操：新增一张系统表

下面以 `pg_my_catalog` 为例，整理成可以直接照做的步骤。

### 3.0 前置要点

- **必须重新 `initdb`**：系统表是在创建新集群时由 `postgres.bki` 生成并执行的；对**已有集群**不会“自动长出”新系统表。
- **是否需要 `.dat` 初始数据**：
  - 只需要“表结构”→ 仅新增 `.h` 即可，表通常是空的。
  - 需要“初始化就有行”→ 需要新增对应 `.dat`（并进入 `genbki.pl` 的输入列表）。
- **字段类型要谨慎**：Bootstrap 阶段受限于最基础类型体系，尽量使用系统早期可用的类型

### 3.1 选择一个可用 OID

先用脚本查看推荐的可用 OID：

```bash
perl src/include/catalog/unused_oids
```

该脚本会扫描现有定义并给出未使用的 OID 范围；从中挑一个给新表使用即可。

### 3.2 新建系统表头文件（`.h`）

在 `src/include/catalog/` 下新增系统表定义文件，例如 `pg_my_catalog.h`：

```c
/*-------------------------------------------------------------------------
 *
 * pg_my_catalog.h
 *    example system catalog
 *
 *-------------------------------------------------------------------------
 */

#ifndef PG_MY_CATALOG_H
#define PG_MY_CATALOG_H

#include "catalog/genbki.h"
#include "catalog/pg_my_catalog_d.h"

/* ----------------
 *      pg_my_catalog definition
 * ---------------- */
CATALOG(pg_my_catalog,8910,MyCatalogRelationId)
{
    Oid     oid;        /* 行 OID：很多 catalog 会保留；是否必须取决于设计 */
    text    info;       /* 自定义信息 */
} FormData_pg_my_catalog;

typedef FormData_pg_my_catalog *Form_pg_my_catalog;

#endif /* PG_MY_CATALOG_H */
```

**关键说明**：

- `CATALOG(表名, 表OID, RelationId宏名)`：系统表定义入口
- `pg_my_catalog_d.h`：由构建流程生成，通常包含常量/宏（如列号宏、RelationId 定义等）
- `oid` 字段：不少系统表会保留；如果你的表不需要行 OID，也可以采用无 OID 的方式（与具体版本/宏使用方式相关）

![image-20260119181326374](/images/posts/xuda/postgresql-create-system-catalog/image-20260119181326374.png)

### 3.3 把头文件注册进构建系统（`CATALOG_HEADERS`）

在 `src/backend/catalog/Makefile` 的 `CATALOG_HEADERS` 中追加新建的头文件名：

```makefile
CATALOG_HEADERS := \
  pg_proc.h pg_type.h pg_attribute.h pg_class.h \
  pg_attrdef.h pg_constraint.h pg_inherits.h pg_index.h pg_operator.h \
  pg_opfamily.h pg_opclass.h pg_am.h pg_amop.h pg_amproc.h \
  pg_language.h pg_largeobject_metadata.h pg_largeobject.h pg_aggregate.h \
  pg_statistic.h pg_statistic_ext.h pg_statistic_ext_data.h \
  pg_rewrite.h pg_trigger.h pg_event_trigger.h pg_description.h \
  pg_cast.h pg_enum.h pg_namespace.h pg_conversion.h pg_depend.h \
  pg_database.h pg_db_role_setting.h pg_tablespace.h \
  pg_authid.h pg_auth_members.h pg_shdepend.h pg_shdescription.h \
  pg_ts_config.h pg_ts_config_map.h pg_ts_dict.h \
  pg_ts_parser.h pg_ts_template.h pg_extension.h \
  pg_foreign_data_wrapper.h pg_foreign_server.h pg_user_mapping.h \
  pg_foreign_table.h pg_policy.h pg_replication_origin.h \
  pg_default_acl.h pg_init_privs.h pg_seclabel.h pg_shseclabel.h \
  pg_collation.h pg_parameter_acl.h pg_partitioned_table.h \
  pg_range.h pg_transform.h \
  pg_sequence.h pg_publication.h pg_publication_namespace.h \
  pg_publication_rel.h pg_subscription.h pg_subscription_rel.h \
  pg_my_catalog.h
```

**补充说明**：

- 这里做的是“让 genbki/构建流程看见你的新 catalog 定义”。
- 一般情况下不需要你手动去改 `pg_class.dat` 之类的文件；新系统表自身在 Bootstrap 阶段会被创建并注册。

### 3.4 重新生成 BKI（编译）

```bash
# 方式 1：全量编译
make

# 方式 2：只生成 catalog/BKI（更快）
make -C src/backend/catalog bki-stamp
```

### 3.5 安装并用 `initdb` 初始化新集群

```bash
make install
# 然后对“新的数据目录”执行 initdb
```

> 重点再强调一次：**要看到新增系统表，必须对新集群 initdb**。

### 3.6 验证系统表是否创建成功

你可以从三个角度验证：

1. **psql 元命令**：`\d pg_my_catalog`
2. **查 `pg_class`**（确认被注册为关系对象）：

```sql
SELECT oid, relname, relnamespace::regnamespace, relkind
FROM pg_class
WHERE relname = 'pg_my_catalog';
```

3. **直接查询新表**（如果没有 `.dat` 初始数据，通常是空表）：

```sql
SELECT * FROM pg_my_catalog;
```

![image-20260119181727859](/images/posts/xuda/postgresql-create-system-catalog/image-20260119181727859.png)

## 04 常见问题与注意事项

### 4.1 为什么我改了源码但老集群里看不到表？

因为系统表是在 `initdb` 阶段由 `postgres.bki` 创建的。你需要：

- 重新 `make install`
- 对一个**新的**数据目录执行 `initdb`

### 4.2 什么时候需要 `.dat`？

- **只需要表结构**：不需要 `.dat`，表为空也没问题。
- **需要预置数据**：需要新增对应的 `.dat`（以及确保它进入 `genbki.pl` 的输入），否则初始化不会自动插入行。

### 4.3 选 OID 有什么原则？

实操层面最稳妥的做法是：**用 `unused_oids` 查，再从推荐范围里挑**。避免“凭感觉”选一个数字导致冲突。

### 4.4 生成_d.h错误？

检查下.h的CATALOG(pg_my_catalog,8910,MyCatalogRelationId)是否有空格，或者格式是否有误。可以参考pg
[PostgreSQL: Documentation: 18: Chapter 68. System Catalog Declarations and Initial Contents](https://www.postgresql.org/docs/current/bki.htm)

## 05 总结

新增系统表的核心流程可以浓缩为一句话：**写 `.h` 定义 → 注册到构建系统 → 重新生成 `postgres.bki` → 安装 → `initdb` 新集群验证**。

对应到动作清单：

1. **确认 OID**：`perl src/include/catalog/unused_oids`
2. **定义表结构**：在 `src/include/catalog/` 下新增 `.h`（如 `pg_my_catalog.h`）
3. **注册到构建系统**：把新头文件加入 `src/backend/catalog/Makefile` 的 `CATALOG_HEADERS`
4. **编译生成**：`make -C src/backend/catalog bki-stamp`（或全量 `make`）
5. **安装初始化**：`make install` + 对新数据目录执行 `initdb`
6. **验证**：`\d` / 查 `pg_class` / 查新表

