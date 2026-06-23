---
title: "PostgreSQL backend 启动链路源码走读"
date: 2026-06-23
draft: false
categories: ["pg基础"]
tags: ["PostgreSQL", "postmaster", "backend", "ServerLoop", "源码走读", "数据库内核"]
description: "从客户端连接进入 ServerLoop 开始，走读 postmaster fork backend、会话初始化以及 SQL 进入执行器的完整链路。"
summary: "围绕 postmaster 与 backend 的分工，梳理 PostgreSQL 客户端连接从 accept 到 exec_simple_query 的关键调用链。"
---
# PostgreSQL 源码学习笔记

从客户端连接到 SQL 执行全链路

这篇笔记整理我阅读 PostgreSQL backend 启动链路，客户端连接怎么进来，postmaster 为什么 fork，backend 怎么接管连接，数据库会话怎么初始化，最后 SQL 字符串怎么进入执行器。

读这条链路时，我反复问自己三个问题：

1. 现在代码运行在哪个进程里，postmaster 父进程还是 backend 子进程？
2. 当前阶段已经拿到了哪些信息，比如 socket、user、database、`PGPROC`？
3. 当前函数结束后，系统进入了哪个生命周期阶段？

## 总体调用链

普通客户端连接的核心骨架如下：

```text
ServerLoop
  -> BackendStartup
     -> fork_process
        child:
          -> BackendInitialize
          -> BackendRun
             -> PostgresMain
                -> InitProcess
                -> InitPostgres
                -> protocol loop
                   -> exec_simple_query
```

一个非常容易记错的点：

```text
PostgresMain
  -> InitProcess
  -> InitPostgres
       -> InitProcessPhase2
```

也就是说，普通 backend 路径里 `InitProcess()` 在 `InitPostgres()` 前面。`InitProcess()` 先让当前 backend 拿到 `PGPROC`，`InitPostgres()` 开头的 `InitProcessPhase2()` 再把这个 `PGPROC` 加入 `ProcArray`，让其他 backend 能看见它。

## 第一阶段：连接怎么进来

相关文件：

```text
src/backend/postmaster/postmaster.c
```

核心函数：

```text
ServerLoop
ConnCreate
BackendStartup
```

这一阶段的本质是：PostgreSQL 在等客户端连接请求。

`postmaster` 是 PostgreSQL 的父进程。它本身不执行 SQL，而是负责监听 socket、接收连接、fork backend、管理子进程生命周期。

核心代码结构可以简化成：

```c
nSockets = initMasks(&readmask);

for (;;)
{
    rmask = readmask;
    selres = select(nSockets, &rmask, NULL, NULL, &timeout);

    if (FD_ISSET(listenfd, &rmask))
    {
        port = ConnCreate(listenfd);
        BackendStartup(port);
    }
}
```

### ListenSocket 是什么？

`ListenSocket[]` 是 postmaster 启动时创建好的监听 socket 数组。里面可能有：

- TCP socket；
- Unix domain socket；
- 多个监听地址对应的 socket。

`initMasks(&readmask)` 没有显式传入 fd，是因为它直接遍历全局变量 `ListenSocket[]`，把所有有效监听 fd 填进 `fd_set`。

### fd_set 是不是在遍历所有 fd？

是的，在 `select()` 模型下，可以理解成需要扫描 fd 集合。

`select()` 的典型特点是：

- 用户态准备一个 `fd_set`；
- 内核检查哪些 fd 就绪；
- 返回后 `fd_set` 被改写，只留下就绪 fd；
- 调用方再用 `FD_ISSET` 判断哪个 fd 有事件。

这就是为什么 `ServerLoop()` 每轮都要复制一份：

```c
memcpy(&rmask, &readmask, sizeof(fd_set));
```

`readmask` 是“我关心哪些监听 socket”，`rmask` 是“这一轮哪些 socket 真有事件”。

### 本阶段一句话

`ServerLoop` 是一个 reactor 模型的轮询实现：postmaster 等连接，有连接就 accept，然后交给 `BackendStartup()` fork backend。

## 第二阶段：fork 是怎么发生的

相关文件：

```text
src/backend/postmaster/postmaster.c
src/backend/postmaster/fork_process.c
```

核心函数：

```text
BackendStartup
fork_process
```

这一阶段的本质是：一个客户端连接，对应一个普通 backend 进程。

`BackendStartup(Port *port)` 仍然先在 postmaster 父进程中执行。它主要做：

- 分配 `Backend *bn`，这是 postmaster 管理子进程的记录；
- 生成 cancel key；
- 判断当前服务器状态能不能接收连接；
- 给正常 backend 分配 child slot；
- 调用 `fork_process()`。

关键代码：

```c
pid = fork_process();
if (pid == 0)
{
    InitPostmasterChild();
    ClosePostmasterPorts(false);
    BackendInitialize(port);
    BackendRun(port);
}
```

### fork 后为什么 socket 还能用？

因为 `fork()` 会复制进程的 fd table。

更准确地说：

```text
fork 不是复制 socket 本身
fork 是复制 fd table
父子进程的 fd 指向同一个内核 socket object
```

所以 `ConnCreate()` accept 出来的客户端连接 fd，在 fork 后父子进程都能看到。子进程可以继续用这个 fd 和客户端通信。

### 父进程为什么还要关闭 fd？

fork 后父进程 postmaster 和子进程 backend 都持有客户端 socket 的 fd。

但设计上：

- backend 才负责处理这个连接；
- postmaster 不应该读写这个客户端连接；
- 父进程不关闭会造成 fd 泄漏；
- fd 泄漏还会影响连接关闭语义。

所以 `ServerLoop()` 在 `BackendStartup(port)` 后会执行：

```c
StreamClose(port->sock);
ConnFree(port);
```

这里关闭的是父进程自己的 fd 副本，不影响子进程继续使用它继承到的 fd。

### fork_process 做了什么？

`fork_process()` 是对系统调用 `fork()` 的薄包装。

核心逻辑：

```c
result = fork();
if (result == 0)
{
    MyProcPid = getpid();
    pg_strong_random_init();
}
return result;
```

fork 返回值的含义：

- `> 0`：父进程中返回，值是子进程 PID；
- `0`：子进程中返回；
- `-1`：fork 失败。

子进程要重设 `MyProcPid`，因为 fork 后很多内存值来自父进程，但 PID 这种进程身份必须更新。

### 本阶段一句话

`fork = 复制执行流 + 继承 IO 状态`。postmaster 通过 fork 把一个客户端连接交给独立 backend 子进程。

## 第三阶段：BackendInitialize

相关文件：

```text
src/backend/postmaster/postmaster.c
```

核心函数：

```text
BackendInitialize
ProcessStartupPacket
```

这一阶段的本质是：backend 刚接手连接，但还没有登录数据库。

`BackendInitialize()` 已经运行在 backend 子进程中。它主要做连接协议握手：

- 保存 `MyProcPort = port`；
- 初始化后端侧 libpq：`pq_init()`；
- 设置 `whereToSendOutput = DestRemote`；
- 解析客户端地址；
- 等待 startup packet；
- 读取 user/database/options；
- 设置进程标题。

关键调用：

```c
status = ProcessStartupPacket(port, false, false);
```

### 为什么要等 startup packet？

PostgreSQL 是协议驱动的数据库服务，不是简单的 HTTP 文本请求。

客户端建立 socket 连接后，必须先发送 startup packet。服务器要从里面知道：

- 协议版本；
- 用户名；
- 数据库名；
- 连接参数；
- 是否是 cancel request。

没有 startup packet，backend 不知道该以哪个用户连接哪个数据库，也不知道后续认证该怎么走。

### ProcessStartupPacket 可能在哪里失败？

常见情况包括：

- 客户端断开；
- 启动包长度不完整；
- 协议版本不支持；
- 这是一个 cancel request；
- socket 读失败；
- 超时。

如果 startup packet 失败，backend 通常会直接退出，不会进入后面的 `PostgresMain()` SQL 会话主循环。

### 为什么这里尽量不碰共享内存？

`BackendInitialize()` 等 startup packet 时，客户端可能恶意卡住或很慢。

PostgreSQL 的设计是：在这个阶段尽量不修改共享内存状态。这样如果发生超时或收到终止信号，子进程可以直接退出，不需要复杂地清理共享状态。

### 本阶段一句话

`BackendInitialize = 连接协议握手阶段`。它负责把 socket 连接变成一个带 user/database 信息的 PostgreSQL 连接。

## 第四阶段：InitProcess 和 InitPostgres

相关文件：

```text
src/backend/tcop/postgres.c
src/backend/storage/lmgr/proc.c
src/backend/utils/init/postinit.c
```

核心函数：

```text
PostgresMain
InitProcess
InitPostgres
InitProcessPhase2
```

`BackendRun()` 会调用：

```c
PostgresMain(ac, av, port->database_name, port->user_name);
```

到 `PostgresMain()` 之后，backend 开始从“拿到连接”进入“初始化数据库会话”。

### InitProcess：进程级初始化

`InitProcess()` 的本质是：让 backend 进入 PostgreSQL 共享内存体系。

它会给当前 backend 分配一个 `PGPROC`。

`PGPROC` 可以理解成 backend 在 PostgreSQL 内核里的共享内存身份证。里面记录：

- 进程 PID；
- 事务 xid/xmin；
- 锁等待状态；
- latch；
- wait event；
- backend 参与事务和锁管理所需的状态。

我当时卡住的问题是：backend 到底在哪里被系统“看到”？

答案就是 `PGPROC`。没有 `PGPROC`，backend 不能正常参与锁、事务可见性、进程信号等机制。

### InitPostgres：会话级初始化

`InitPostgres()` 的本质是：让 backend 成为一个真正的数据库用户会话。

它做的事情包括：

- `InitProcessPhase2()`，把 `PGPROC` 加入 `ProcArray`；
- 初始化 shared invalidation；
- 分配 `MyBackendId`；
- 注册 timeout handler；
- 初始化 buffer pool backend 访问；
- 初始化 relcache、catcache、plancache；
- 初始化 portal manager；
- 初始化 pgstat；
- 开启初始化事务；
- 认证用户；
- 打开 database；
- 设置 session user；
- 设置 namespace/search_path。

### 为什么要初始化 relcache/catcache？

PostgreSQL 的元数据都存在系统 catalog 表里，比如：

- `pg_class`；
- `pg_attribute`；
- `pg_database`；
- `pg_authid`。

执行 SQL 时会频繁查这些元数据。如果每次都直接读磁盘，性能会很差。所以 backend 需要初始化 relcache/catcache，作为系统元数据缓存。

### 为什么 InitProcess 在前，但还要 Phase2？

可以分两步理解：

```text
InitProcess
  -> 拿到 PGPROC

InitPostgres
  -> InitProcessPhase2
     -> 加入 ProcArray
```

先有进程身份，再加入全局可见体系。

`InitProcess()` 创建了“我是谁”；`InitProcessPhase2()` 让其他 backend 能在 `ProcArray` 中看到“我在这里”。

### 本阶段一句话

`InitProcess = 进程注册进数据库内核`；`InitPostgres = 数据库登录 + 会话环境初始化`。

## 第五阶段：PostgresMain 协议循环

相关文件：

```text
src/backend/tcop/postgres.c
```

核心函数：

```text
PostgresMain
ReadCommand
```

初始化完成后，backend 进入一个长期循环：

```c
for (;;)
{
    ReadyForQuery(whereToSendOutput);
    firstchar = ReadCommand(&input_message);

    switch (firstchar)
    {
        case 'Q':
            exec_simple_query(query_string);
            break;
    }
}
```

### 为什么 backend 不执行完一条 SQL 就退出？

因为 backend 对应的是 session，不是单条 SQL。

一个客户端连接建立后，可能会执行很多条 SQL：

```sql
select 1;
select 2;
begin;
insert into t values (...);
commit;
```

所以 backend 要一直留在协议循环里，反复读取客户端消息。

### SQL 为什么一开始是字符串？

在 simple query protocol 中，客户端发给服务端的就是一段 SQL 字符串：

```text
'Q' + "select 1;"
```

`PostgresMain()` 读到消息类型 `'Q'` 后，会把消息体中的 SQL 字符串取出来，然后交给 `exec_simple_query()`。

### 本阶段一句话

`PostgresMain = SQL 协议解释器`。它负责把前后端协议消息分派到不同 SQL 执行入口。

## 第六阶段：exec_simple_query

相关文件：

```text
src/backend/tcop/postgres.c
```

核心函数：

```text
exec_simple_query
```

这一阶段的本质是：SQL 字符串进入编译和执行链路。

整体流程：

```text
SQL string
  -> Parser
  -> Rewrite
  -> Planner
  -> Executor
```

对应源码流程大致是：

```text
pg_parse_query
  -> pg_analyze_and_rewrite
  -> pg_plan_queries
  -> CreatePortal / PortalDefineQuery / PortalStart
  -> PortalRun
```

### SQL 怎么变成执行计划？

PostgreSQL 的 SQL 执行流程很像编译器：

- Parser：把 SQL 字符串解析成语法树；
- Analyzer：做语义分析，比如表名、列名、类型检查；
- Rewrite：应用规则系统，比如视图展开；
- Planner：生成执行计划；
- Executor：执行计划并返回结果。

### Portal 是什么？

`Portal` 可以理解成一次查询执行上下文容器。

它保存：

- 查询字符串；
- command tag；
- plan tree；
- 执行状态；
- 结果返回目标。

simple query 使用 unnamed portal，也就是名字为空字符串的 portal。

### 本阶段一句话

`exec_simple_query = SQL 编译 + 执行入口`。

## 第七阶段：IO 模型和 WaitEventSet

前面 `ServerLoop()` 里看到的是 `select()`，这很容易引出一个问题：PostgreSQL 到底是不是 epoll？

答案要分层看。

在一些老路径或特定路径里，仍能看到 `select()`。但 PostgreSQL 也有统一的等待事件抽象，比如 `WaitEventSet`，用于屏蔽不同平台的 IO 等待差异。

可以粗略理解为：

```text
WaitEventSet
  -> Linux epoll
  -> Unix poll
  -> Windows 对应等待机制
  -> fallback select/poll 路径
```

不同版本和不同模块的实现细节会不同，但抽象目标是一致的：不要让上层逻辑到处关心具体平台的 IO 多路复用 API。

### fd_set 为什么还存在？

原因包括：

- 历史代码路径；
- 可移植性；
- postmaster 某些监听逻辑本身比较简单；
- fallback 需要。

### 本阶段一句话

PostgreSQL 的 IO 等待可以理解成跨平台 reactor 抽象：底层可能是 select、poll、epoll 或平台相关机制，上层尽量通过统一接口组织等待事件。

## 第八阶段：MemoryContext

PostgreSQL 里大量内存不是直接用 `malloc/free` 管，而是用 `MemoryContext`。

这一点非常关键。

### 为什么不用 malloc？

SQL 生命周期很复杂：

- 一条语句解析阶段会分配内存；
- 计划阶段会分配内存；
- 执行阶段会分配内存；
- portal、transaction、session 都有不同生命周期；
- 错误发生时可能要 longjmp 回上层。

如果所有对象都靠手动 `free`，代码会非常难写，也非常容易泄漏。

PostgreSQL 用 MemoryContext 把内存组织成树：

```text
TopMemoryContext
  -> PostmasterContext
  -> MessageContext
  -> PortalContext
  -> QueryContext
```

不同阶段把内存分配到不同 context 中，阶段结束时可以批量释放。

### palloc 和 malloc 的区别

| malloc | palloc |
| --- | --- |
| 分配普通堆内存 | 分配到当前 MemoryContext |
| 需要手动 free | 可以随 context 批量释放 |
| 出错路径容易泄漏 | 更适合 PostgreSQL 的错误恢复模型 |
| 不理解 SQL 生命周期 | 和 session/query/transaction 生命周期绑定 |

### 本阶段一句话

`MemoryContext = PostgreSQL 的数据库级内存生命周期管理结构`。它不是 GC，但承担了很多“按阶段批量回收”的职责。

## 第九阶段：进程池改造思路

这一部分是我的项目方向：把 PostgreSQL 原来的 process-per-connection 模型，尝试改造成 worker pool 调度模型。

原模型：

```text
accept
  -> fork
  -> backend
```

我想探索的模型：

```text
accept
  -> MSG_PEEK startup packet
  -> 选择 worker
  -> SCM_RIGHTS 传递 fd
  -> worker/backend 复用
```

### 为什么要 peek startup packet？

如果要做 worker pool，postmaster 或 dispatcher 需要在不真正消费协议数据的情况下，提前知道一些路由信息，比如：

- user；
- database；
- application_name；
- 是否能按 database affinity 分配 worker。

`MSG_PEEK` 可以“偷看”socket 数据，但不从 socket 接收缓冲区移除它。

### peek startup packet 有什么风险？

风险不少：

- TCP 可能分包，一次 peek 不一定拿到完整 startup packet；
- socket 可能是非阻塞的，读到 `EAGAIN`；
- startup packet 长度字段需要谨慎处理；
- cancel request 和普通 startup packet 要区分；
- TLS/GSS 等握手路径会让事情更复杂。

所以 peek 不能写成“我读一次就一定拿到完整包”。它需要状态机和超时处理。

### worker 如何选？

可以考虑几种策略：

- database affinity：同一个 database 尽量分配到同一组 worker；
- idle queue：优先选择空闲 worker；
- fallback worker：没有合适 worker 时走兜底路径；
- 负载指标：考虑当前 worker 的连接数、事务状态、内存压力等。

### 什么时候算连接成功？

PostgreSQL 原生路径里，一个连接真正成为正常数据库会话，大致要等 `InitPostgres()` 成功完成。

进程池模型里可能要拆成两个层次：

- dispatcher 层：fd 成功交给 worker，只能说明“连接已派发”；
- worker 层：`InitPostgres()` 成功，才说明“数据库会话建立成功”。

这两个概念不能混在一起。

### 本阶段一句话

我想做的是：

```text
process-per-connection
  -> process-pool-dispatch
```

它不是简单把 fork 去掉，而是要重新设计连接接管、协议窥探、fd 传递、worker 生命周期和失败回退。

## 两个练习

### 练习一：打印 backend 启动日志

我先在 `PostgresMain()` 中 `InitPostgres()` 之后加了一条 DEBUG 日志：

```c
elog(DEBUG1,
     "backend startup trace: pid=%d user=%s database=%s remote=%s",
     (int) MyProcPid,
     username,
     dbname,
     MyProcPort->remote_host);
```

实际日志类似：

```text
DEBUG:  backend startup trace: pid=3007965 user=xuda database=postgres remote=[local]
```

这条日志可以验证：

- 它是在 backend 子进程里打印的；
- startup packet 已经读完；
- `username/dbname/remote_host` 已经可用；
- 如果放在 `InitPostgres()` 之后，说明数据库会话初始化也完成了。

### 练习二：统计 backend 启动阶段耗时

第二个练习是实现一条 timing 日志：

```text
backend startup timing:
  pid=...
  user=...
  database=...
  remote=...
  startup_packet_ms=...
  init_process_ms=...
  init_postgres_ms=...
  total_ms=...
```

实现思路：

- 在 `Port` 结构体里增加若干 `TimestampTz` 字段；
- 在 `BackendInitialize()` 入口记录 backend 子进程开始初始化时间；
- 在 `ProcessStartupPacket()` 之后记录 startup packet 完成时间；
- 在 `PostgresMain()` 中 `InitProcess()` 前后记录耗时；
- 在 `InitPostgres()` 前后记录耗时；
- 在 `InitPostgres()` 成功返回后输出 `DEBUG1` 日志。

这个练习让我理解到：`Port` 是连接生命周期中很自然的状态承载对象。它从 `ConnCreate()` 创建，经由 fork 复制到子进程，再通过 `MyProcPort` 在 `PostgresMain()` 中继续可见。

## 总结：一句话版本

PostgreSQL backend 生命周期可以压缩成：

```text
连接进入
  -> fork
  -> 连接初始化
  -> 进程初始化
  -> 会话初始化
  -> SQL 协议循环
  -> 执行器
```

更口语一点：

> postmaster 只负责接连接和 fork；backend 子进程负责读取 startup packet、初始化进程状态和数据库会话，然后在 `PostgresMain()` 的协议循环中读取客户端消息，最终把 simple query 交给 `exec_simple_query()` 执行。

而我的进程池改造目标是：

```text
fork per connection
  -> worker pool dispatch
```

也就是把“每个连接 fork 一个 backend”的模型，改造成“连接进入后派发给可复用 worker”的模型。

## 后续继续读什么？

这条链路读完后，可以继续往几个方向深入：

- `ReadCommand()`：前后端协议消息怎么读；
- extended query protocol：`Parse/Bind/Execute/Sync` 和 simple query 的区别；
- `InitPostgres()` 内部认证、HBA、打开数据库的细节；
- `PGPROC`、`ProcArray` 和事务可见性；
- MemoryContext 的层级和错误恢复；
- buffer manager：`BufferDesc`、`BM_DIRTY`、`BM_VALID`、`PinBuffer()`、`ReadBuffer_common()`；
- executor：`PortalRun()` 后面怎么进入执行器。


