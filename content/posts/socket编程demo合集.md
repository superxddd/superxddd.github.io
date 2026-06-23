# Socket 编程 Demo 合集

这份笔记记录三条主线：

1. 最基础的 TCP 客户端/服务端流程
2. PostgreSQL 风格的 `fork per connection` 服务端
3. `epoll + 非阻塞 IO + 长度前缀协议` 服务端

核心目标不是背 API，而是理解几种 server 架构的分工。

## 1. TCP 基础流程

### 服务端主线

```text
socket
bind
listen
accept
read / write
close
```

服务端最重要的是区分两个 fd：

```text
listenfd / serverfd
    只负责监听和 accept 新连接。

connfd
    accept 返回的 fd，负责和某个客户端通信。
```

### 客户端主线

```text
socket
connect
write / read
close
```

客户端不需要 `bind/listen/accept`。它只需要知道服务端的 IP 和端口，然后 `connect`。

## 2. PostgreSQL 风格：fork per connection

PostgreSQL 的经典模型可以粗略理解成：

```text
postmaster 父进程:
    负责 listen / accept
    每来一个连接就 fork 一个 backend
    自己继续 accept 新连接

backend 子进程:
    只服务一个客户端连接
    处理完后退出
```

也就是：

```text
父进程 accept 得到 connfd
fork

子进程:
    close(serverfd)
    handle_client(connfd)
    close(connfd)
    exit

父进程:
    close(connfd)
    继续 accept
```

### 为什么父进程 fork 后要 close(connfd)

`fork` 后，父子进程都会持有一份 `connfd`：

```text
父进程 fd 表:
    serverfd
    connfd

子进程 fd 表:
    serverfd
    connfd
```

父进程不负责和这个客户端通信，所以 fork 成功后应该立刻：

```text
父进程 close(connfd)
```

子进程不负责监听新连接，所以应该：

```text
子进程 close(serverfd)
```

这样职责才干净：

```text
父进程只接客
子进程只聊天
```

### SIGCHLD 的职责

`SIGCHLD` 不是用来关闭 `connfd` 的。  
`SIGCHLD` 只负责通知父进程：

```text
有子进程退出了，需要 waitpid 回收
```

所以：

```text
connfd 的关闭:
    父进程 fork 后马上 close 自己那份
    子进程 handle_client 结束后 close 自己那份

SIGCHLD:
    waitpid 回收子进程 pid
```

### fork 版服务端示意

```c++
#include <arpa/inet.h>
#include <iostream>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

using namespace std;

void sigchld_handler(int sig) {
  int status;
  pid_t pid;

  while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
    if (WIFEXITED(status)) {
      cout << "回收子进程 " << pid
           << " exit code=" << WEXITSTATUS(status) << endl;
    }
  }
}

void handle_client(int connfd) {
  char buf[1024];
  int n = read(connfd, buf, sizeof(buf));
  if (n > 0) {
    write(connfd, buf, n);
  }
}

int main() {
  int serverfd = socket(AF_INET, SOCK_STREAM, 0);

  sockaddr_in serveraddr{};
  serveraddr.sin_family = AF_INET;
  serveraddr.sin_port = htons(5432);
  serveraddr.sin_addr.s_addr = INADDR_ANY;

  bind(serverfd, reinterpret_cast<sockaddr *>(&serveraddr), sizeof(serveraddr));
  listen(serverfd, 128);

  signal(SIGCHLD, sigchld_handler);

  while (true) {
    sockaddr_in connaddr{};
    socklen_t len = sizeof(connaddr);
    int connfd = accept(serverfd, reinterpret_cast<sockaddr *>(&connaddr), &len);
    if (connfd < 0) {
      continue;
    }

    pid_t pid = fork();

    if (pid == 0) {
      close(serverfd);
      handle_client(connfd);
      close(connfd);
      exit(0);
    }

    if (pid > 0) {
      close(connfd);
      continue;
    }

    close(connfd);
  }
}
```

### fork 版的特点

优点：

- 结构直观
- 一个连接一个进程，连接之间隔离性好
- 某个 backend 崩了，不一定影响父进程
- 很适合理解 PostgreSQL 的 postmaster/backend 模型

缺点：

- 进程开销比线程/事件循环大
- 连接很多时进程数量会很多
- 需要认真处理子进程回收、信号、资源关闭

## 3. epoll + 非阻塞 IO

`epoll` 是事件通知机制。它不等于非阻塞 IO。

```text
epoll:
    告诉你哪个 fd 有事件

非阻塞 IO:
    read/write/accept 不会一直卡死
    没数据时返回 -1，并设置 errno=EAGAIN
```

常见高性能服务端组合是：

```text
epoll + O_NONBLOCK + 读/写到 EAGAIN
```

### epoll 版主线

```text
socket
setsockopt(SO_REUSEADDR)
bind
listen
set_nonblock(listenfd)
epoll_create1
epoll_ctl 添加 listenfd

while true:
    epoll_wait

    如果是 listenfd:
        while true:
            accept
            如果 EAGAIN: break
            set_nonblock(connfd)
            epoll_ctl 添加 connfd

    如果是 connfd:
        如果 EPOLLIN:
            while true:
                recv
                如果 EAGAIN: break
        如果 EPOLLOUT:
            while out buffer 不空:
                send
                如果 EAGAIN: break
```

### 为什么 ET 模式要读到 EAGAIN

如果使用：

```text
EPOLLET
```

这是边缘触发。意思是状态发生变化时通知你一次。  
所以收到 `EPOLLIN` 后要尽量把数据读完，直到：

```text
errno == EAGAIN 或 EWOULDBLOCK
```

否则可能还有数据留在内核缓冲区，但你不会再收到新的通知。

## 4. 粘包：长度前缀协议

TCP 是字节流，不是消息流。

不能假设：

```text
一次 write == 一次 read
```

可能发生：

```text
粘包:
    客户端发 hello 和 world
    服务端一次读到 helloworld

半包:
    客户端发 hello
    服务端第一次只读到 he
    第二次才读到 llo
```

真实常用解法之一是长度前缀协议：

```text
[4 字节长度][正文内容]
```

例如发送 `"hello"`：

```text
[00000005][hello]
```

服务端收包时：

```text
每个客户端 fd 维护自己的输入缓冲区 in
recv 到数据后 append 到 in

只要 in 至少有 4 字节:
    读出 body_len
    如果 in 不够 4 + body_len:
        break，等下次 recv
    否则:
        拆出完整消息
        从 in 中删除已处理数据
```

发送时也要考虑非阻塞写：

```text
每个客户端 fd 维护自己的输出缓冲区 out
send 成功多少就删除多少
没写完就继续监听 EPOLLOUT
```

## 5. epoll 非阻塞服务端关键结构

当前 `epoll-server.cpp` 的核心结构是：

```c++
struct Client {
  string in;
  string out;
};
```

含义：

```text
in:
    当前客户端的接收缓冲区，用于处理半包/粘包。

out:
    当前客户端的发送缓冲区，用于处理非阻塞写没写完。
```

核心函数：

```text
set_nonblock(fd)
    把 fd 设置成非阻塞。

read_client(fd, client)
    循环 recv，读到 EAGAIN。

parse_messages(fd, client)
    从 client.in 中按长度前缀拆消息。

append_message(client.out, msg)
    把 [4字节长度][正文] 追加到输出缓冲区。

write_client(fd, client)
    循环 send，写到 out 空或 EAGAIN。

update_events(epfd, fd, client)
    如果 out 不空，就监听 EPOLLOUT。
    如果 out 空，就只监听 EPOLLIN。
```

## 6. 客户端长度前缀协议

客户端发送一条消息：

```text
send_message:
    htonl(msg.size())
    send_all(4 字节长度)
    send_all(正文)
```

客户端接收一条消息：

```text
read_message:
    read_all(4 字节长度)
    ntohl 得到正文长度
    read_all(正文)
```

重点：

```text
send 不保证一次写完
read 不保证一次读满
```

所以要有：

```text
send_all
read_all
```

## 7. 三种模型对比

### 阻塞单进程

```text
accept
read
write
close
```

特点：

- 最容易理解
- 一次只能认真处理一个连接
- 适合入门

### fork per connection

```text
父进程 accept
fork backend
子进程处理 connfd
父进程继续 accept
```

特点：

- 接近 PostgreSQL 经典模型
- 每个连接一个进程
- 父进程要处理 SIGCHLD 回收子进程

### epoll + 非阻塞

```text
一个进程管理很多 fd
epoll_wait 等事件
非阻塞 read/write
每个连接维护 in/out buffer
```

特点：

- 适合大量连接
- 状态管理比 fork 模型复杂
- 要处理 EAGAIN、半包、写缓冲

## 8. 常见坑

### 1. fork 后子进程继续执行父进程逻辑

子进程处理完后要：

```text
exit(0)
```

否则可能继续回到父进程的 accept 循环。

### 2. 父进程忘记 close(connfd)

父进程 fork 后必须关闭自己的 `connfd` 副本。  
否则连接引用计数不干净，客户端断开时行为可能变怪。

### 3. 子进程忘记 close(serverfd)

子进程不负责监听新连接，应该关闭 `serverfd`。

### 4. read/write 直接操作 string 对象

不要这样：

```c++
string msg;
read(fd, &msg, 1024);
```

应该读到字符数组，或者读到 `string` 内部已经分配好的缓冲区。

### 5. write 写了整个 buf

错误思路：

```c++
write(fd, buf, sizeof(buf));
```

正确思路：

```c++
int n = read(fd, buf, sizeof(buf));
write(fd, buf, n);
```

### 6. epoll ET 模式没读到 EAGAIN

使用 `EPOLLET` 时，`accept/recv/send` 都要循环做到不能继续为止。

### 7. 忘记每个连接单独维护 buffer

处理粘包/半包时，不能只有一个全局 buffer。  
每个客户端 fd 都要有自己的缓存。

## 9. 编译运行

编译客户端：

```bash
g++ socket-user.cpp -o socket-user
```

编译 fork 服务端：

```bash
g++ socket-server.cpp -o socket-server
```

编译 epoll 服务端：

```bash
g++ epoll-server.cpp -o epoll-server
```

运行时先启动服务端：

```bash
./epoll-server
```

再启动客户端：

```bash
./socket-user
```

如果端口被占用：

```bash
ss -ltnp | grep 7777
```

或者换一个端口。

## 10. 学习路线

建议按这个顺序巩固：

```text
1. 阻塞 TCP echo server
2. TCP client 循环输入
3. fork per connection server
4. SIGCHLD + waitpid(WNOHANG)
5. 长度前缀协议
6. epoll LT
7. epoll ET + O_NONBLOCK + EAGAIN
8. 每连接 in/out buffer
```

你现在已经走到了：

```text
fork 模型能看懂
epoll 模型能写出骨架
知道粘包要靠协议解决
开始理解 PostgreSQL postmaster/backend 的进程模型
```
