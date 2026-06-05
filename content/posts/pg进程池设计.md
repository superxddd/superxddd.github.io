---
title: "PostgreSQL 内部进程池设计笔记"
date: 2026-06-05
draft: false
categories: ["pg设计"]
tags: ["PostgreSQL", "进程池", "连接管理", "后端进程", "数据库内核"]
description: "整理数据库 server 内部 backend 进程池的设计目标、连接派发、fd passing、session 清理、信号处理和回收策略。"
summary: "进程池的核心不是提前 fork worker，而是安全复用 backend 进程，并在每个 session 结束后清理干净。"
---

# Server Process Pool 详细设计说明

本文是一份面向实现的进程池设计文档。
目标是以后在新的代码库或新的公司里，可以对照本文重新理解、设计或实现一个数据库 server 内部的 backend 进程池。

## 1. 背景

传统 PostgreSQL/UDB 连接模型是“一连接一 backend 进程”：

```text
client connect
  -> postmaster accept()
  -> BackendStartup()
  -> fork backend
  -> backend 初始化 PGPROC、认证、进入 SQL 协议循环
  -> client disconnect
  -> backend 退出
```

这个模型简单、安全，因为每个连接结束时进程退出，进程内状态天然被操作系统清理。

但它在短连接场景下成本高：

- 每个连接都要 `fork()`
- 每个 backend 都要重复初始化共享内存访问、PGPROC、ProcSignal、libpq、认证上下文等
- 连接突刺时，postmaster 需要频繁创建/回收进程

进程池的目标是把模型改成：

```text
server startup
  -> 预先 fork 一批 serverprocessN worker

client connect
  -> postmaster accept()
  -> 找一个 idle worker
  -> 把 client socket fd 派发给 worker
  -> worker 服务这个 session
  -> session 结束后清理进程内状态
  -> worker 回到 idle，等待下一个 session
```

核心收益是降低短连接的连接建立成本。
它不直接优化 SQL 执行本身。

## 2. 设计目标

### 2.1 功能目标

- 启动时预创建一批 backend-like worker。
- 新连接优先派发给空闲 worker。
- pool 不可用、连接不适合进程池、派发失败时回退到普通 `BackendStartup()`。
- worker 处理完 session 后不退出，而是清理状态并回到 idle。
- 支持扩容、缩容、进程异常退出后的恢复。
- 支持 cancel request、reload、shutdown。
- 支持 SQL 可见的进程池状态查询。

### 2.2 非目标

- 不做外部连接池代理。
- 不改变前端协议语义。
- 不绕过 PostgreSQL/UDB 原有认证、权限、事务、锁管理。
- 不直接提升单条 SQL 的执行性能。

## 3. 和 PgBouncer 的区别

PgBouncer 是数据库外部的连接池代理：

```text
client -> PgBouncer -> PostgreSQL backend
```

PgBouncer 复用的是“到数据库的连接”。

本设计是数据库内部的进程池：

```text
client -> postmaster -> serverprocessN
```

本设计复用的是“backend 进程本身”。

因此，本设计最大难点不是连接转发，而是：

```text
一个 backend 进程服务完用户 A 后，
必须清理干净，
才能安全服务用户 B。
```

## 4. 总体架构

```text
                    +--------------------+
                    |    postmaster      |
                    |  ServerLoop()      |
                    +---------+----------+
                              |
                              | accept()
                              v
                    +--------------------+
                    |      Port          |
                    |    port->sock      |
                    +---------+----------+
                              |
              +---------------+----------------+
              |                                |
       ordinary path                    process pool path
              |                                |
              v                                v
      BackendStartup()              DispatchSessionViaPool()
              |                                |
              v                                v
         fork backend          SendSocketToServerProcess()
                                               |
                                               v
                                  +-----------------------+
                                  |    serverprocessN     |
                                  |  ServerProcessMain()  |
                                  +-----------+-----------+
                                              |
                                              v
                                  ServerWorkerProcess()
                                              |
                                              v
                                  DetachServerSession()
                                              |
                                              v
                                      return to idle
```

## 5. 核心数据结构

### 5.1 `ServerProcessEntry`

每个 pool worker 对应一个 `ServerProcessEntry`。

它记录 worker 的进程身份、状态、通信管道和数据库 affinity：

```c
typedef struct ServerProcessEntry
{
    pid_t       pid;
    uint64      sessionId;
    int         index;
    ProcessState state;
    int         pipes[2];
    int         pmChildSlot;
    Latch       latch;
    bool        inUse;
    int         restartCount;
    ProcessAffinityState affinityState;
    ProcessListKind listKind;
    int32       cancelKey;
    Oid         dbOid;
    char        dbName[NAMEDATALEN];
    pg_atomic_uint32 needRestart;
} ServerProcessEntry;
```

核心字段含义：

- `pid`: worker 进程 pid。
- `sessionId`: 当前绑定的 session，idle 时为 0。
- `state`: `IDLE/BUSY/STARTING/SHUTDOWN/DEAD`。
- `pipes[2]`: postmaster 和 worker 之间传递 socket fd 的 Unix socketpair。
- `pmChildSlot`: postmaster child slot。
- `cancelKey`: 当前 session 的 cancel key。
- `affinityState/dbOid/dbName`: worker 和数据库的绑定状态。
- `needRestart`: 标记 worker 服务完当前 session 后不再复用，需要退出重启。

### 5.2 `ProcessPoolManage`

整个 pool 的共享管理结构：

```c
typedef struct ProcessPoolManage
{
    slock_t           poolLock;
    pg_atomic_uint32  totalProcesses;
    pg_atomic_uint32  idleProcesses;
    pg_atomic_uint32  busyProcesses;
    int               maxProcesses;
    pid_t             managerPid;

    ConnectionStats   connectionStats;

    dlist_head        idleUnboundList;
    dlist_head        busyProcessList;
    ProcessAffinityBucket idleAffinity[PROCESS_POOL_AFFINITY_BUCKETS];

    ServerProcessEntry serverWorkers[FLEXIBLE_ARRAY_MEMBER];
} ProcessPoolManage;
```

核心设计点：

- `poolLock` 保护 list membership。
- `entryLock` 保护单个 `ServerProcessEntry` 的可变字段。
- idle worker 分两类：
  - unbound idle worker
  - affinity idle worker
- busy worker 单独放在 busy list。

## 6. 启动流程

### 6.1 postmaster 启动 pool

在 postmaster 启动完成后：

```text
if IsEnableProcessPool()
  InitProcessPool()
  StartProcessPoolMgr()
```

`IsEnableProcessPool()` 通常由 GUC 决定，例如：

```text
ud_server_process_num > 0
```

### 6.2 初始化共享内存

需要为以下内容分配共享内存：

- `UdbTxSga`
- session UGA hash
- `ProcessPoolManage`
- `ServerProcessEntry[]`

初始化时要设置：

- total/idle/busy 计数为 0
- idle/busy list 初始化
- affinity bucket 初始化
- 每个 entry 初始化为 `DEAD/inUse=false`
- spinlock 和 atomic 初始化

### 6.3 预创建 worker

`InitProcessPool()` 按 `ud_server_process_num` 创建初始 worker：

```text
for i in initialProcesses:
  entry = GetServerProcess(i)
  ExpandServerProcess(entry)
```

`ExpandServerProcess()` 做：

```text
socketpair()
AssignUnvdbsvrChildSlot()
StartServerProcess()
```

`StartServerProcess()` 做：

```text
fork_process()
  child:
    InitUnvdbsvrChild()
    CloseUnvdbsvrPorts(false)
    InitLatch()
    ServerProcessMain(entry)

  parent:
    entry->pid = pid
    attach entry to idle list
    totalProcesses++
    idleProcesses++
```

## 7. 普通连接流程

传统路径：

```text
ServerLoop()
  ConnCreate()
    StreamConnection()
      accept()
  BackendStartup(port)
    fork_process()
    child:
      BackendInitialize(port)
      InitProcess()
      BackendRun(port)
```

这是进程池的 fallback。
任何不适合进程池的连接都应该能回到这个路径。

## 8. 进程池连接派发流程

### 8.1 accept 后判断是否使用 pool

postmaster 在 `ServerLoop()` accept 后得到 `Port`：

```text
port->sock = accept(listen_socket)
```

然后判断：

```text
canAcceptConnections(BACKEND_TYPE_NORMAL) == CAC_OK
ShouldUseProcessPool()
TryPeekSessionStartupParams(port)
!port->dedicated_connection
!port->cancel_request_connection
```

满足条件时走：

```text
DispatchSessionViaPool(port)
```

否则：

```text
BackendStartup(port)
```

### 8.2 `TryPeekSessionStartupParams()`

这个函数用 `recv(... MSG_PEEK ...)` 偷看 startup packet。

关键点：

- 不消费 socket 数据。
- 只用于提前知道 `database/user/options`。
- 如果是 cancel request、SSL/GSS negotiation、packet 不完整，则不走 pool。
- 支持通过 startup options 强制 dedicated 模式。

### 8.3 claim idle worker

派发入口：

```text
DispatchSessionViaPool()
  DispatchSession()
    ClaimIdleServerProcess(dbName)
```

claim 策略：

1. 优先找同数据库 affinity 的 idle worker。
2. 找不到再找 unbound idle worker。
3. 找到后从 idle list 移到 busy list。

```text
idleProcesses--
busyProcesses++
entry->state = BUSY
```

### 8.4 创建 session 记录

postmaster 创建一个 session id，并把连接信息保存到共享 session hash：

```text
CreateNewSession(port, &sessionId)
```

session 记录至少包含：

- session id
- client socket
- local/remote addr
- TCP keepalive 参数

注意：共享 hash 必须有并发保护。

### 8.5 fd passing

普通 backend 靠 fork 继承 `port->sock`。

pool worker 已经存在，无法靠 fork 继承新连接 fd，因此必须用 Unix fd passing：

```text
postmaster:
  sendmsg(worker_pipe, SCM_RIGHTS, port->sock, sessionId)

worker:
  recvmsg(worker_pipe)
  得到 clientSock + sessionId
```

核心 API：

```c
sendmsg(... SCM_RIGHTS ...)
recvmsg(... SCM_RIGHTS ...)
```

派发成功后，postmaster 可以关闭自己持有的 `port->sock`。
worker 持有收到的 fd，负责和 client 通信。

## 9. Worker 主循环

worker 入口：

```text
ServerProcessMain(entry)
```

启动时做：

```text
ServerProcessBackend = true
SetSeverProcessSignals()
InitProcess()
BaseInit()
InitProcSignal()
ConfigureServerProcessWaitSet(entry->pipes[1])
```

主循环：

```text
for (;;)
  WaitEventSetWait()
  HandleMainLoopInterrupts()
  if needRestart:
    proc_exit(0)
  if pipe readable:
    RecvSocketFromDispatch()
    ServerWorkerProcess(index, clientSock, sessionId)
    ReturnServerProcessToIdle()
```

worker idle 时也必须处理：

- SIGHUP reload
- SIGTERM shutdown
- SIGINT residue
- proc signal barrier
- postmaster death
- needRestart

## 10. Worker 服务单个 session

`ServerWorkerProcess()` 的职责：

```text
AttachServerSession()
BackendInitialize()
ServerProcessRun()
DetachServerSession()
ReleaseConnection()
DestorySession()
```

### 10.1 attach

`AttachServerSession()` 从共享 session hash 读取连接信息，创建 worker 本地 `Port`：

```text
sessionId -> SessionUGA -> Port
port->sock = clientSock
entry->sessionId = sessionId
```

### 10.2 backend 初始化

`BackendInitialize(port)`：

- 设置 `MyProcPort`
- 初始化 libpq
- 读取 startup packet
- 处理认证前信息
- 设置 `database_name/user_name`

普通 backend 在这里失败时可以退出进程。
pool worker 不能随便退出，应该把连接错误转成可恢复路径，或标记 worker restart。

### 10.3 执行 SQL 协议循环

`ServerProcessRun()`：

```text
RandomCancelKey()
entry->cancelKey = MyCancelKey
ProcessPoolConnError = PP_CONN_SUCCESS
UnvdbMain(database, user)
```

如果连接阶段报错：

- 向客户端发错误
- 清理 error state
- 必要时清除 affinity
- 标记 `needRestart`

成功后：

- 记录 database affinity
- 上报 disconnect pgstat

## 11. Session 清理设计

这是进程池最核心的部分。

普通 backend 退出时，以下状态随进程消失。
pool worker 不退出，所以必须显式清理。

### 11.1 必须清理的状态

事务：

- abort 当前事务或失败事务
- 重置 transaction command state
- 释放 snapshot
- 确保不残留 transaction block

锁：

- `LockReleaseAll(DEFAULT_LOCKMETHOD, true)`
- `LockReleaseAll(USER_LOCKMETHOD, true)`
- 必要时释放 LWLock residue

SQL/session 对象：

- portal
- prepared statement
- unnamed statement
- plan cache
- sequence cache
- LISTEN/NOTIFY
- advisory lock

GUC：

- session-level GUC
- `session_authorization`
- GUC report state
- client encoding
- role/user/security context

临时对象：

- temp table
- temp namespace
- local buffer
- temp file

内存：

- `MessageContext`
- row description context
- query context
- 连接相关 `Port` 字段

统计和状态：

- pgstat session 状态
- backend status
- ps display
- cancel key
- `MyProcPort`
- timeout/interrupt flags

扩展和 hook：

- session preload library
- extension 维护的 backend-lifetime 状态
- on_proc_exit/on_shmem_exit 注册项是否安全

### 11.2 当前实现的清理流程

当前 `DetachServerSession()` 覆盖了：

```text
AbortOutOfAnyTransaction()
LockReleaseAll(DEFAULT_LOCKMETHOD, true)
PortalHashTableDeleteAll()
session_authorization reset
ResetAllOptions()
DropAllPreparedStatements()
Async_UnlistenAll()
LockReleaseAll(USER_LOCKMETHOD, true)
ResetPlanCache()
ResetTempTableNamespace()
ResetTempNamespaceState()
ResetSequenceCaches()
pgstat_report_stat(true)
ResetLocalBuffersForPool()
ResetPooledSessionGlobals()
ResetReportingGUCOptions()
FinalizeSessionUserId()
FinalizeSystemUser()
FinalizeClientEncoding()
SessionState_Shutdown()
MessageContext cleanup
entry->sessionId = 0
entry->cancelKey = 0
```

### 11.3 清理失败策略

清理失败时，不应继续复用 worker。

推荐策略：

```text
if cleanup failed:
  entry->needRestart = 1
  ReturnServerProcessToIdle() 不放回 idle list
  worker 主循环看到 needRestart 后 proc_exit(0)
  postmaster 处理 worker exit
  pool 自动补一个新 worker
```

清理函数最好用 PG_TRY/PG_CATCH 包住。
如果 cleanup 抛 ERROR，必须标记 restart，并避免把 worker 放回 idle。

## 12. Cancel Request 设计

普通 cancel request 使用：

```text
backend pid + cancel key
```

postmaster 在普通 `BackendList` 中查找 pid。

pool worker 不一定在普通 backend list 中，因此需要额外查 pool：

```text
ProcessPoolHandleCancelRequest(pid, cancelKey)
```

规则：

- 只有 `state == BUSY` 且 `sessionId != 0` 才允许 cancel。
- cancel key 必须匹配当前 session。
- 匹配后对 worker pid 发送 `SIGINT`。
- worker 回 idle 前必须清掉过期 `QueryCancelPending`。

## 13. Reload 设计

`SELECT pg_reload_conf()` 的大致路径：

```text
pg_reload_conf()
  kill(postmaster, SIGHUP)

postmaster:
  process_pm_reload_request()
  ProcessConfigFile(PGC_SIGHUP)
  SignalChildren(SIGHUP)
```

普通 backend 在 `BackendList` 里，可以收到 SIGHUP。

pool worker 不在普通 `BackendList` 里，因此必须额外通知：

```text
SignalProcessPoolChildren(SIGHUP)
```

worker 侧：

```text
SIGHUP -> SignalHandlerForConfigReload()
  ConfigReloadPending = true
  SetLatch(MyLatch)

ServerProcessMain()
  HandleMainLoopInterrupts()
    ProcessConfigFile(PGC_SIGHUP)
```

否则会出现：

```text
SELECT pg_reload_conf();
普通 backend reload 生效
pool worker 没有重新读取配置
```

## 14. Shutdown 设计

shutdown 需要覆盖：

- smart shutdown
- fast shutdown
- immediate shutdown
- postmaster crash

推荐规则：

smart shutdown：

- 停止接受新连接。
- 已有 busy worker 跑完当前 session。
- idle worker 不再接新 session。
- 进入 stop-backends 阶段后给 pool worker 发 SIGTERM。

fast shutdown：

- 给 pool worker 发 SIGTERM。
- busy worker 回滚事务并退出。

immediate shutdown：

- 给 pool worker 发 SIGQUIT/SIGABRT。
- 不要求优雅清理。

postmaster death：

- worker wait set 监听 `WL_UNVDBSVR_DEATH`。
- postmaster 异常退出时 worker FATAL 退出。

## 15. Worker Recycle 设计

进程池不应该只依赖“完美 cleanup”。

即使 `DetachServerSession()` 覆盖了大多数核心状态，backend 进程长期复用后仍可能积累一些 backend-lifetime 状态：

- extension 私有全局变量
- session preload library 状态
- 内存碎片
- cache 膨胀
- fd/resource owner 边角泄漏
- JIT/SPI/DSM/临时文件状态
- GUC hook 或插件内部状态
- 某些异常路径留下的残余状态

普通 backend 退出时，这些状态会随进程消失。
pool worker 不退出，因此需要一个 worker recycle 策略。

### 15.1 Recycle 触发条件

推荐支持以下触发条件：

```text
servedSessionCount >= max_sessions
workerLifetime >= max_lifetime
memoryUsage >= max_memory
cleanup failed
session preload libraries loaded
local buffer reset failed
database drop / affinity invalid
```

其中最小可行方案是：

```text
每个 worker 服务 N 个 session 后重启
```

推荐 GUC：

```text
ud_server_process_max_sessions = 1000
ud_server_process_max_lifetime = 3600s
ud_server_process_recycle_memory = 1GB
ud_server_process_recycle_jitter = 10%
```

`jitter` 用来避免大量 worker 同时达到阈值、同时重启。

### 15.2 Recycle 流程

不要一次性重建整个 pool。
推荐滚动重建单个 worker：

```text
session 结束
  servedSessionCount++
  if need recycle:
    entry->needRestart = 1

ReturnServerProcessToIdle()
  if needRestart:
    不放回 idle list
    state = SHUTDOWN

ServerProcessMain()
  看到 needRestart
  proc_exit(0)

postmaster
  HandleSeverProcessExit()
  CleanupDeadSeverProcess()
  ExpandServerProcess()
```

这样可以保证：

- 当前 session 正常结束后再重启。
- worker 不再接新连接。
- pool 容量由 postmaster 自动补齐。
- 不会造成整池抖动。

### 15.3 Recycle 和 Cleanup 的关系

推荐原则：

```text
尽量清干净 + 周期性换新进程
```

cleanup 是正确性的第一道防线。
recycle 是工程稳定性的第二道防线。

不能因为有 recycle 就放松 cleanup。
也不能假设 cleanup 永远完美，因此必须有 recycle。

## 16. 扩容和缩容

### 16.1 扩容

当没有 idle worker 时：

```text
TryExpandServerProcess()
  FindFreeProcessSlot()
  ExpandServerProcess()
  retry ClaimIdleServerProcess()
```

扩容数量由：

```text
ud_server_expand_step_num
```

控制。

### 16.2 缩容

pool manager 定期扫描 idle worker：

```text
if totalProcesses > ud_server_process_num
and idle time > ud_server_process_idle_time:
  mark worker shutdown
  kill(pid, SIGTERM)
```

缩容数量由：

```text
ud_server_scale_down_step_num
```

控制。

## 17. Database Affinity

worker 可以和数据库绑定：

```text
PROCESS_AFFINITY_NONE
PROCESS_AFFINITY_RESERVED
PROCESS_AFFINITY_CONNECTED
PROCESS_AFFINITY_RESTARTING
```

设计目的：

- 同一个数据库的连接优先复用同一个 worker。
- 减少数据库级初始化/缓存切换成本。
- database drop 或不可用时，可以标记相关 worker restart。

claim 顺序：

```text
same-db affinity idle worker
  -> unbound idle worker
  -> expand
  -> fallback
```

数据库删除时：

```text
MarkDatabaseWorkersNeedRestart(dboid, dbname)
```

被标记的 worker 不再接新 session，之后退出并重建。

## 18. 统计和可观测性

建议提供 SQL 函数：

```sql
select * from ud_process_pool_status();
select * from ud_process_pool_connection_stats();
select * from ud_process_pool_connection_detail();
```

建议统计项：

- pool enabled
- total processes
- idle processes
- busy processes
- max processes
- total requests
- hit count
- miss count
- current active connections
- historical max active connections
- per-worker pid/state/active seconds/wait seconds

日志建议：

- worker start/exit/restart
- dispatch success/failure
- sendmsg/recvmsg failure
- cleanup failure
- reload signal to pool workers
- scale up/down
- affinity bind/clear

## 19. 当前实现中需要重点修正的问题

以下问题是实现进程池时最容易遗漏，也最容易造成随机问题的地方。

### 19.1 `DetachServerSession()` 不应重复调用

成功连接时不能执行两次 session cleanup。

错误模式：

```c
if (connection_successful)
    DetachServerSession(entry, sessionId);

DetachServerSession(entry, sessionId);
```

应改为：

```c
DetachServerSession(entry, sessionId);
```

或：

```c
if (connection_successful)
    DetachServerSession(entry, sessionId);
else
    CleanupFailedSessionAndMarkRestart(entry, sessionId);
```

### 19.2 共享 session hash 必须加锁

以下操作不能无锁并发：

```text
HASH_ENTER
HASH_FIND
HASH_REMOVE
```

推荐：

```text
LWLockAcquire(ShmUdbSga->lock, LW_EXCLUSIVE)
hash_search(...)
LWLockRelease(...)
```

如果读多写少，也可以拆读写锁，但要保证 dynahash 并发安全。

### 19.3 `ReleaseConnection()` 需要释放 `Port` 内部字段

普通 backend 退出进程，很多 `strdup/pstrdup` 泄漏无所谓。
pool worker 复用进程，必须释放。

重点字段：

- `remote_host`
- `remote_port`
- `remote_hostname`
- `database_name`
- `user_name`
- `cmdline_options`
- SSL/GSS 相关资源

同时 postmaster 侧 `TryPeekSessionStartupParams()` 对 `Port` 的 `pstrdup` 字段也要有释放路径。

### 19.4 reload 必须通知 pool worker

不能只通知 `ProcessPoolMgrPID`。
需要遍历 `serverWorkers[]` 给有效 worker 发 SIGHUP。

### 19.5 cleanup 需要 PG_TRY 兜底

`DetachServerSession()` 里会访问 catalog、temp namespace、GUC、pgstat、local buffer。
任何 ERROR 都不能导致 worker 被错误放回 idle。

推荐：

```text
PG_TRY:
  DetachServerSession()
PG_CATCH:
  EmitErrorReport()
  FlushErrorState()
  entry->needRestart = 1
PG_END_TRY
```

### 19.6 fd passing 需要校验完整性

`recvmsg()` 后应检查：

- 返回字节数是否等于 `sizeof(sessionId)`
- `msg_flags & MSG_CTRUNC` 是否为 0
- control message 长度是否足够
- 收到 fd 后异常路径是否 close

### 19.7 统计计数必须成对回滚

以下计数要保证所有路径成对：

- `idleProcesses`
- `busyProcesses`
- `totalProcesses`
- `currentActiveConnects`
- `hitConnections`
- `missConnections`

特别注意：

- `SendSocketToServerProcess()` 失败
- worker 收到 fd 后 `BackendInitialize()` 失败
- worker cleanup 失败
- worker 异常退出
- preempt/scale-down

### 19.8 缺少 worker recycle 策略

如果 worker 可以无限期复用，即使 cleanup 当前看起来完整，也容易在长时间运行后积累不可见状态。

至少应支持：

```text
max sessions per worker
max lifetime per worker
cleanup failure -> restart
```

推荐先实现 `max sessions per worker`，因为它最容易验证，收益也最直接。

## 20. 测试计划

### 20.1 基础功能

```sql
select * from ud_process_pool_status();
select * from ud_process_pool_connection_stats();
select * from ud_process_pool_connection_detail();
```

验证：

- pool enabled
- idle/busy/total 变化正确
- 连接结束后 worker 回 idle

### 20.2 短连接性能

场景：

```text
connect
select 1
disconnect
```

对比：

- 传统 fork 模式
- process pool 模式

指标：

- connect latency p50/p95/p99
- QPS
- fork 次数
- CPU sys time

### 20.3 session 污染测试

session A：

```sql
set search_path = xxx;
set application_name = 'a';
prepare s as select 1;
listen chan;
create temp table t(id int);
begin;
select pg_advisory_lock(1);
rollback;
```

断开后 session B 检查：

```sql
show search_path;
show application_name;
select * from pg_prepared_statements;
select * from pg_listening_channels();
select to_regclass('pg_temp.t');
select pg_try_advisory_lock(1);
```

预期：不应看到 A 的残留状态。

### 20.4 reload 测试

```sql
show archive_timeout;
alter system set archive_timeout = '60s';
select pg_reload_conf();
\c -
show archive_timeout;
```

预期 pool worker 上也能看到新值。

### 20.5 cancel 测试

```sql
select pg_sleep(60);
```

另一个连接 cancel。

验证：

- cancel key 匹配才发 SIGINT
- busy worker 被 cancel
- idle worker 不被误 cancel
- 下一个 session 没有 `QueryCancelPending` 残留

### 20.6 shutdown 测试

分别测试：

- smart shutdown
- fast shutdown
- immediate shutdown
- postmaster crash

验证：

- idle worker 退出
- busy worker 正确中断或完成
- postmaster 不会卡在等待 pool worker
- shared counters 最终归零

### 20.7 异常路径测试

模拟：

- sendmsg 失败
- recvmsg 无 fd
- worker 初始化失败
- temp table cleanup 失败
- local buffer pinned
- database drop 后 affinity worker 被重启

验证：

- worker 不被错误复用
- session hash 被删除
- fd 没泄漏
- counters 没负数或错位

### 20.8 recycle 测试

配置较小的 session 阈值：

```text
ud_server_process_max_sessions = 3
```

连续建立 5 次短连接，验证：

- worker 服务 3 个 session 后被标记 restart。
- 被标记的 worker 不再接新连接。
- postmaster 自动补新 worker。
- pool 总容量没有明显抖动。
- busy worker 不会被强行中断，只在 session 结束后 recycle。

## 21. 实现检查清单

实现或 review 时逐项检查：

- [ ] pool worker 不在普通 `BackendList` 时，reload/cancel/shutdown 有额外路径。
- [ ] worker idle loop 会处理 latch、SIGHUP、SIGTERM、postmaster death。
- [ ] fd passing 使用 `SCM_RIGHTS`，并校验 `recvmsg()` 完整性。
- [ ] postmaster 派发成功后关闭自己的 client socket。
- [ ] worker release connection 时关闭 client socket。
- [ ] session hash 所有访问有锁保护。
- [ ] cleanup 只执行一次。
- [ ] cleanup ERROR 会标记 worker restart。
- [ ] session GUC、role、client encoding、temp namespace、prepared statement、LISTEN、portal 都被清理。
- [ ] local buffer 无 pin 才 reset，否则 worker restart。
- [ ] cancel key 每个 session 重新生成，并在 idle 时清零。
- [ ] worker 有按 session 数、生命周期或异常条件触发的 recycle 策略。
- [ ] recycle 是滚动重启单个 worker，而不是整池同时重建。
- [ ] pool counters 所有路径成对维护。
- [ ] worker abnormal exit 能被 postmaster 识别和恢复。
- [ ] database affinity 在 DB drop/rename/不可连接时正确清除或重启。
- [ ] SQL 状态函数能帮助定位 idle/busy/leak。

## 22. 一句话总结

进程池的核心不是“提前 fork 几个进程”，而是：

```text
把 client socket 安全交给已有 backend-like worker，
并在每个 session 结束后，
把这个复用进程恢复到足够接近新 backend 的干净状态。
```

只要清理、信号、fd、共享状态这四件事没有设计好，进程池就会变成随机污染和随机 crash 的来源。
