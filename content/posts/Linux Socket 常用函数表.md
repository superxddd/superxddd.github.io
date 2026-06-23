---
title: "Linux 编程基础：Linux Socket 常用函数表"
date: 2026-06-08
draft: false
categories: ["系统编程"]
tags: ["Linux", "fd", "IO 多路复用", "select", "poll", "epoll"]
description: "介绍socket相关的函数和参数。"
summary: "便于日常查询使用socket。"
---

# Linux Socket 常用函数速查表

---

# 1. socket()

创建 socket

```c
int socket(
    int domain,
    int type,
    int protocol
);
```

## 参数

### domain

| 参数     | 说明         |
| -------- | ------------ |
| AF_INET  | IPv4         |
| AF_INET6 | IPv6         |
| AF_UNIX  | 本地进程通信 |

### type

| 参数        | 说明 |
| ----------- | ---- |
| SOCK_STREAM | TCP  |
| SOCK_DGRAM  | UDP  |

### protocol

一般填 0

```c
socket(AF_INET, SOCK_STREAM, 0);
```

---

# 2. bind()

绑定 IP 和端口

```c
int bind(
    int sockfd,
    const struct sockaddr *addr,
    socklen_t addrlen
);
```

## 常见

```c
struct sockaddr_in addr;

addr.sin_family = AF_INET;
addr.sin_port = htons(5432);
addr.sin_addr.s_addr = INADDR_ANY;

bind(fd,
     (struct sockaddr *)&addr,
     sizeof(addr));
```

---

# 3. listen()

把 socket 变成监听 socket

```c
int listen(
    int sockfd,
    int backlog
);
```

## 参数

### backlog

等待队列长度

```c
listen(fd, 128);
```

---

# 4. accept()

接受客户端连接

```c
int accept(
    int sockfd,
    struct sockaddr *addr,
    socklen_t *addrlen
);
```

## 返回

返回新的连接 fd

```c
int connfd = accept(
    listenfd,
    (struct sockaddr *)&client,
    &len
);
```

注意：

```
listenfd
    ↓
accept()
    ↓
connfd
```

以后读写都用 connfd

---

# 5. connect()

客户端连接服务器

```c
int connect(
    int sockfd,
    const struct sockaddr *addr,
    socklen_t addrlen
);
```

```c
connect(fd,
        (struct sockaddr *)&server,
        sizeof(server));
```

---

# 6. read()

读取数据

```c
ssize_t read(
    int fd,
    void *buf,
    size_t count
);
```

```c
char buf[1024];

int n = read(fd, buf, sizeof(buf));
```

## 返回

| 返回值 | 说明       |
| ------ | ---------- |
| >0     | 读取字节数 |
| =0     | 对端关闭   |
| <0     | 错误       |

---

# 7. write()

发送数据

```c
ssize_t write(
    int fd,
    const void *buf,
    size_t count
);
```

```c
write(fd, buf, len);
```

---

# 8. recv()

接收数据

```c
ssize_t recv(
    int sockfd,
    void *buf,
    size_t len,
    int flags
);
```

## 常见 flags

### 0

普通读取

```c
recv(fd, buf, sizeof(buf), 0);
```

---

### MSG_PEEK

偷窥数据

读取但不移除

```c
recv(fd,
     buf,
     sizeof(buf),
     MSG_PEEK);
```

场景：

- PostgreSQL startup packet
- HTTP头预读
- 协议识别

---

### MSG_DONTWAIT

非阻塞

```c
recv(fd,
     buf,
     sizeof(buf),
     MSG_DONTWAIT);
```

读不到立即返回

errno：

```c
EAGAIN
EWOULDBLOCK
```

---

# 9. send()

发送数据

```c
ssize_t send(
    int sockfd,
    const void *buf,
    size_t len,
    int flags
);
```

```c
send(fd, buf, len, 0);
```

---

# 10. close()

关闭 fd

```c
int close(int fd);
```

```c
close(fd);
```

---

# sockaddr_in

IPv4地址结构

```c
struct sockaddr_in
{
    sa_family_t sin_family;

    in_port_t sin_port;

    struct in_addr sin_addr;
};
```

## 示例

```c
struct sockaddr_in addr;

addr.sin_family = AF_INET;
addr.sin_port = htons(5432);

addr.sin_addr.s_addr = INADDR_ANY;
```

---

# htons()

Host To Network Short

主机字节序 → 网络字节序

```c
htons(5432);
```

---

# htonl()

Host To Network Long

```c
htonl(ip);
```

---

# ntohs()

Network To Host Short

```c
port = ntohs(addr.sin_port);
```

---

# ntohl()

Network To Host Long

```c
ip = ntohl(addr.sin_addr.s_addr);
```

---

# inet_pton()

字符串IP → 二进制IP

```c
inet_pton(
    AF_INET,
    "127.0.0.1",
    &addr.sin_addr
);
```

---

# inet_ntop()

二进制IP → 字符串IP

```c
char ip[64];

inet_ntop(
    AF_INET,
    &addr.sin_addr,
    ip,
    sizeof(ip)
);
```

---

# select()

最老的IO多路复用

```c
int select(
    int nfds,
    fd_set *readfds,
    fd_set *writefds,
    fd_set *exceptfds,
    struct timeval *timeout
);
```

---

# FD_SET()

添加监听fd

```c
FD_SET(fd, &readfds);
```

---

# FD_CLR()

删除fd

```c
FD_CLR(fd, &readfds);
```

---

# FD_ISSET()

判断是否就绪

```c
if (FD_ISSET(fd, &readfds))
{
}
```

---

# poll()

poll版IO复用

```c
int poll(
    struct pollfd *fds,
    nfds_t nfds,
    int timeout
);
```

---

# epoll_create1()

创建 epoll

```c
int epoll_create1(0);
```

---

# epoll_ctl()

管理fd

```c
epoll_ctl(
    epfd,
    EPOLL_CTL_ADD,
    fd,
    &ev
);
```

## 操作

| 参数          | 说明 |
| ------------- | ---- |
| EPOLL_CTL_ADD | 添加 |
| EPOLL_CTL_MOD | 修改 |
| EPOLL_CTL_DEL | 删除 |

---

# epoll_event

```c
struct epoll_event
{
    uint32_t events;

    epoll_data_t data;
};
```

---

# events

| 参数     | 说明     |
| -------- | -------- |
| EPOLLIN  | 可读     |
| EPOLLOUT | 可写     |
| EPOLLERR | 错误     |
| EPOLLHUP | 对端关闭 |
| EPOLLET  | 边缘触发 |

---

# epoll_wait()

等待事件

```c
int epoll_wait(
    int epfd,
    struct epoll_event *events,
    int maxevents,
    int timeout
);
```

## 返回

```c
n = epoll_wait(...);
```

n 表示：

```
本次就绪fd数量
```

例如：

```
fd 5 可读
fd 8 可读
fd 11 可读
```

返回

```c
n = 3
```

然后遍历：

```c
for(int i = 0; i < n; i++)
{
}
```

---

# 服务端标准流程

```text
socket()
    ↓
bind()
    ↓
listen()
    ↓
epoll_create()
    ↓
epoll_ctl(listenfd)
    ↓
epoll_wait()
    ↓
accept()
    ↓
connfd
    ↓
epoll_ctl(connfd)
    ↓
read/write
    ↓
close()
```